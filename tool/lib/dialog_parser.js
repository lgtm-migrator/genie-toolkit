// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');
const Stream = require('stream');

class DialogueSerializer extends Stream.Transform {
    constructor(options = { annotations: true }) {
        super({ writableObjectMode: true });

        this._buffer = [];
        this._annotations = options.annotations;
    }

    _pushMany(values) {
        for (const v of values)
            this.push(v);
    }

    _prefixLines(text, prefix) {
        return text.split('\n').map((line) => prefix + line + '\n');
    }

    _transform(dlg, encoding, callback) {
        this.push('====\n');
        this.push('# ' + dlg.id + '\n');
        if (dlg.comment)
            this._pushMany(this._prefixLines(dlg.comment, '# '));

        for (let i = 0; i < dlg.turns.length; i++) {
            const turn = dlg.turns[i];
            if (i > 0) {
                if (this._annotations)
                    this._pushMany(this._prefixLines(turn.context, 'C: '));
                this.push('A: ' + turn.agent + '\n');
                if (this._annotations)
                    this._pushMany(this._prefixLines(turn.agent_target, 'AT: '));
            }
            this.push('U: ' + turn.user + '\n');
            if (this._annotations)
                this._pushMany(this._prefixLines(turn.user_target, 'UT: '));
        }

        callback();
    }

    _flush(callback) {
        callback();
    }
}

const KEY_SEQUENCE = ['context', 'agent', 'agent_target', 'user', 'user_target'];

class DialogueParser extends Stream.Transform {
    constructor() {
        super({ objectMode: true });

        this._buffer = [];
        this._i = 0;
    }

    _transform(line, encoding, callback) {
        line = line.trim();

        // comment or empty line
        if (!line || line.startsWith('#')) {
            callback();
            return;
        }

        // end of current dialog
        if (line.startsWith('====')) {
            this._flush(callback);
            return;
        }

        // buffer the current line
        this._buffer.push(line);
        callback();
    }

    _flush(callback) {
        const lines = this._buffer;
        if (lines.length === 0) {
            // ignore `====` at the beginning or at the end
            // or consecutive appearances of `====`
            // this simplifies concatenating datasets
            callback();
            return;
        }
        this._buffer = [];

        const dlg = [];
        let currentTurn = {
            context: '',
            agent: '',
            agent_target: '',
            user: '',
            user_target: '',
        };

        // first turn starts with the user
        let expect = KEY_SEQUENCE.indexOf('user');
        function flushTurn() {
            dlg.push(currentTurn);
            currentTurn = {
                context: '',
                agent: '',
                agent_target: '',
                user: '',
                user_target: '',
            };
        }

        let currentKey = null;
        let text = '';
        for (let line of lines) {
            let key, newText;
            if (line.startsWith('A:')) {
                key = 'agent';
                newText = line.substring(2).trim();
            } else if (line.startsWith('U:')) {
                key = 'user';
                newText = line.substring(2).trim();
            } else if (line.startsWith('AT:')) {
                key = 'agent_target';
                newText = line.substring(3).trim();
            } else if (line.startsWith('UT:')) {
                key = 'user_target';
                newText = line.substring(3).trim();
            } else if (line.startsWith('C:')) {
                key = 'context';
                newText = line.substring(2).trim();
            } else {
                throw new Error(`malformed line ${line}, expected to start with U:, A:, AT: or UT:`);
            }
            if (currentKey !== null && currentKey !== key) {
                assert(text);
                currentTurn[currentKey] = text;
                text = '';

                if (currentKey === KEY_SEQUENCE[KEY_SEQUENCE.length-1])
                    flushTurn();
            }

            if (currentKey !== key) {
                if (key !== KEY_SEQUENCE[expect])
                    throw new Error(`malformed dialogue ${this._i}, expected ${KEY_SEQUENCE[expect]}, saw ${key}`);
                expect = (expect + 1) % KEY_SEQUENCE.length;
                currentKey = key;
            }
            text += newText;
        }

        if (currentKey !== KEY_SEQUENCE[KEY_SEQUENCE.length-1])
            throw new Error(`malformed dialogue ${this._i}, unterminated last turn`);

        currentTurn[currentKey] = text;
        flushTurn();

        dlg.id = this._i;
        this._i++;
        callback(null, dlg);
    }
}

module.exports = {
    DialogueParser,
    DialogueSerializer,
};
