// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>

import * as Tp from 'thingpedia';
import * as events from 'events';

import SpeechRecognizer from './speech_recognizer';
import SpeechSynthesizer from './speech_synthesizer';
import { MessageType } from '../dialogue-agent/protocol';
import type Conversation from '../dialogue-agent/conversation';
import type AudioController from '../dialogue-agent/audio/controller';
import { AudioPlayer, CustomPlayerSpec } from '../dialogue-agent/audio/interface';

interface SpeechHandlerOptions {
    nlUrl ?: string;
}

class LocalAudioPlayer implements AudioPlayer {
    private _handler : SpeechHandler
    private _cap : Tp.Capabilities.AudioPlayerApi;
    readonly conversationId : string;
    private _player : Tp.Capabilities.Player|null;

    constructor(handler : SpeechHandler, platform : Tp.BasePlatform, conversation : Conversation) {
        this.conversationId = conversation.id;
        this._handler = handler;
        this._cap = platform.getCapability('audio-player')!;
        this._player = null;
    }

    async checkCustomPlayer(spec : CustomPlayerSpec) : Promise<boolean> {
        return spec.type === 'url';
    }

    async prepare(spec ?: CustomPlayerSpec) : Promise<void> {
        if (spec && spec.type !== 'url')
            throw new Error(`unsupported`);

        // wait until the agent finishes speaking to start playing audio
        await this._handler.waitFinishSpeaking();
    }

    async stop() : Promise<void> {
        if (this._player)
            await this._player.stop();
        this._player = null;
    }
    async playURLs(urls : string[]) : Promise<void> {
        await this.stop();
        this._player = await this._cap.play(urls);
    }
    async setVolume(volume : number) : Promise<void> {
        throw new Error('Method not implemented.');
    }
    async setMute(mute : boolean) : Promise<void> {
        throw new Error('Method not implemented.');
    }
}

export default class SpeechHandler extends events.EventEmitter {
    private _platform : Tp.BasePlatform;
    private _prefs : Tp.Preferences;
    private _conversation : Conversation;
    private _pulse : Tp.Capabilities.SoundApi;
    private _wakeWordDetector : Tp.Capabilities.WakeWordApi|null;
    private _voiceDetector : Tp.Capabilities.VadApi|null;
    private _systemLock : Tp.Capabilities.SystemLockApi|null;
    private _recognizer : SpeechRecognizer;
    private _tts : SpeechSynthesizer;
    private _currentRequest : any;
    private _started : boolean;
    private _enableVoiceInput : boolean;
    private _enableVoiceOutput : boolean;
    private _stream : any|null = null;
    private _audioController : AudioController;
    private _queuedAudio : string[];
    private _player : LocalAudioPlayer|null;

    constructor(conversation : Conversation,
                platform : Tp.BasePlatform,
                options : SpeechHandlerOptions = {
                    nlUrl: 'https://almond-nl.stanford.edu'
                }) {
        super();
        this._platform = platform;
        this._prefs = platform.getSharedPreferences();

        this._conversation = conversation;
        this._audioController = conversation.engine.audio;

        this._pulse = platform.getCapability('sound')!;
        this._wakeWordDetector = platform.getCapability('wakeword-detector');
        this._voiceDetector = platform.getCapability('voice-detector');
        this._systemLock = platform.getCapability('system-lock');

        if (this._wakeWordDetector) {
            this._wakeWordDetector.on('wakeword', (wakeword : string, buffer : Buffer) => {
                if (this._systemLock && this._systemLock.isActive) {
                    console.log('Ignored wakeword ' + wakeword + ' because the system is locked');
                    return;
                }

                console.log('Wakeword ' + wakeword + ' detected');
                this._onDetected(buffer);
            });
        }

        this._recognizer = new SpeechRecognizer({
            locale: this._platform.locale,
            nlUrl: options.nlUrl,
            vad: this._voiceDetector
        });
        this._recognizer.on('error', (e) => {
            this.emit('error', e);
        });
        this._tts = new SpeechSynthesizer(platform, options.nlUrl);

        this._currentRequest = null;
        this._queuedAudio = [];

        this._started = true;
        this._enableVoiceInput = this._prefs.get('enable-voice-input') as boolean ?? true;
        this._enableVoiceOutput = this._prefs.get('enable-voice-output') as boolean ?? true;

        this._prefs.on('changed', (key : string) => {
            if (key === 'enable-voice-input')
                this.setVoiceInput(this._prefs.get('enable-voice-input') as boolean ?? true);
            else if (key === 'enable-voice-output')
                this.setVoiceOutput(this._prefs.get('enable-voice-output') as boolean ?? true);
        });

        this._player = null;
        if (this._platform.hasCapability('audio-player'))
            this._player = new LocalAudioPlayer(this, platform, conversation);
    }

    setVoiceInput(enable : boolean) : void {
        if (enable === this._enableVoiceInput)
            return;
        this._enableVoiceInput = enable;
        if (this._started && enable)
            this._startVoiceInput();
        else
            this._stopVoiceInput();
    }

    setVoiceOutput(enable : boolean) : void {
        if (enable === this._enableVoiceOutput)
            return;
        this._enableVoiceOutput = enable;
        if (!enable)
            this._tts.clearQueue();
    }

    // called from conversation
    async setHypothesis() {
        // ignore, this is called from the conversation when it broadcasts the hypothesis
        // to all listeners
    }
    async addDevice() {
        // ignore
    }

    waitFinishSpeaking() {
        return new Promise<void>((resolve, reject) => {
            if (!this._tts.speaking) {
                resolve();
                return;
            }

            this._tts.once('done', () => resolve());
        });
    }

    async setExpected(expect : string) : Promise<void> {
        // flush any request to play audio
        if (this._queuedAudio.length) {
            const toPlay = this._queuedAudio;
            this._queuedAudio = [];
            if (!this._player)
                return;

            const player = this._player;
            await this._audioController.requestSystemAudio({
                async stop() {
                    await player.stop();
                }
            }, this._conversation.id);
            await player.playURLs(toPlay);
        }
    }

    async addMessage(message : any) : Promise<void> {
        switch (message.type) {
        case MessageType.COMMAND:
            await this._tts.clearQueue();
            break;

        case MessageType.TEXT:
            if (!this._enableVoiceOutput)
                break;
            await this._tts.say(message.text);
            break;

        case MessageType.SOUND_EFFECT: {
            const soundEffects = this._platform.getCapability('sound-effects');
            if (soundEffects) {
                if (message.exclusive) {
                    // in exclusive mode, we queue the sound effect as if it was
                    // a regular audio URL
                    // this means we'll stop other audio and we will synchronize
                    // with audio messages
                    const url = soundEffects.getURL(message.name);

                    if (url)
                        this._queuedAudio.push(url);
                    else
                        console.log(`Ignored unknown sound effect ${message.name}`);
                } else {
                    this.waitFinishSpeaking().then(() => {
                        return soundEffects.play(message.name);
                    }).catch((e) => {
                        console.error(`Failed to play sound effect: ${e.message}`);
                    });
                }
            } else {
                console.log(`Ignored sound effect ${message.name}: not supported on this platform`);
            }
            break;
        }

        case MessageType.AUDIO:
            this._queuedAudio.push(message.url);
            break;

        // ignore all other message types
        }
    }

    /**
     * Programmatically trigger a wakeword.
     *
     * This can be used to emulate a wakeword with a push button.
     */
    wakeword() : void {
        this._onDetected(Buffer.from([]));
    }

    private _onDetected(buffer : Buffer, mustHaveWakeword = true) {
        // if we already have a request active, ignore the wakeword, we're
        // already streaming the sound to the server
        if (this._currentRequest)
            return;

        this.emit('wakeword');

        this._currentRequest = this._recognizer.request(this._stream, buffer);
        this._currentRequest.on('hypothesis', (hypothesis : string) => {
            this._conversation.setHypothesis(hypothesis);
        });
        this._currentRequest.on('done', (status : string, utterance : string) => {
            this._currentRequest = null;
            if (status === 'Success') {
                console.log('Recognized as "' + utterance + '"');

                if (mustHaveWakeword) {
                    const wakeWordMatch = /^(computer)[,.!]?/i.exec(utterance);
                    if (!wakeWordMatch) {
                        console.log('Ignored because wake-word is missing');
                        this.emit('no-match');
                        return;
                    }
                    // remove the prefix from the utterance so we don't confuse
                    // the model
                    utterance = utterance.substring(wakeWordMatch[0].length).trim();
                }
                // if there is nothing left, start listening again in case
                // the user paused in-between the wakeword and the command
                // in that case, we will not check for the wakeword and remove it
                //if (!utterance) {
                //    this._onDetected(Buffer.from([]), false);
                //    return;
                //}
                this.emit('match');
                this._conversation.setHypothesis('');
                this._conversation.handleCommand(utterance);
            } else if (status === 'NoMatch' || status === 'InitialSilenceTimeout') {
                this.emit('no-match');
            } else {
                console.log('Recognition error: ' + status);
            }
        });
        this._currentRequest.on('error', (error : Error) => {
            this._currentRequest = null;
            this._onError(error);
        });
    }

    private _onError(error : Error) {
        console.log('Error in speech recognition: ' + error.message);
        this._tts.say("Sorry, I had an error understanding your speech: " + error.message);
    }

    start() : void {
        this._conversation.addOutput(this, false);
        if (this._player)
            this._audioController.addPlayer(this._player);
        this._started = true;

        if (this._enableVoiceInput)
            this._startVoiceInput();
    }

    private _startVoiceInput() {
        this._stream = this._pulse.createRecordStream({
            format: 'S16LE',
            rate: 16000,
            channels: 1,
            stream: 'genie-voice-output',
            properties: {
                'media.role': 'voice-assistant',
                'filter.want': 'echo-cancel',
            }
        });

        this._stream!.on('state', (state : string) => {
            console.log('Record stream is now ' + state);
            if (state === 'ready')
                this.emit('ready');
        });

        if (this._voiceDetector)
            this._voiceDetector.setup(16000, 3);

        if (this._wakeWordDetector)
            this._stream!.pipe(this._wakeWordDetector);
    }

    async stop() {
        if (this._player) {
            await this._player.stop();
            this._audioController.removePlayer(this._player);
        }
        this._conversation.removeOutput(this);
        this._started = false;
        this._stopVoiceInput();
        this._tts.clearQueue();
    }

    private _stopVoiceInput() {
        if (!this._stream)
            return;
        this._stream.unpipe();
        this._stream.end();
        this._stream = null;
        this._recognizer.close();
    }
}
