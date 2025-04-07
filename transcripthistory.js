'use strict';
const AhoCorasick = require('./ahocorasick');

class TranscriptHistory {
    constructor(phrases) {
        this.finder = new AhoCorasick(phrases);
        // Determine the maximum number of words needed to look back on
        // based on the longest phrase.
        this.maxWords = Math.max(1, this.#longestPhraseInWords(phrases) - 1);

        // Set up a circular buffer to avoid costly shift() calls.
        this.buffer = new Array(this.maxWords);
        this.reset();
    }

    #longestPhraseInWords(phrases) {
        let max = 0;
        for (let i = 0, len = phrases.length; i < len; i++) {
            // Trim once and split on whitespace.
            const count = phrases[i].phrase.trim().split(/\s+/).length;
            if (count > max) max = count;
        }
        return max;
    }

    // Checks if the sentence needs to be cleaned (without allocating any memory)
    // The common case will be no cleaning so no additional objects allocated
    #needsCleaning(sentence) {
        const len = sentence.length;
        if (len === 0) return false;

        // Check for leading or trailing spaces.
        if (sentence.charCodeAt(0) === 32 || sentence.charCodeAt(len - 1) === 32) return true;

        let lastWasSpace = false;
        for (let i = 0; i < len; i++) {
            const code = sentence.charCodeAt(i);

            if (code === 32) {
                // space character
                if (lastWasSpace) return true; // consecutive space found
                lastWasSpace = true;
                continue;
            }

            lastWasSpace = false;

            // Allow digits: '0'-'9'
            if (code >= 48 && code <= 57) continue;

            // Allow lowercase letters: 'a'-'z'
            if (code >= 97 && code <= 122) continue;

            // Any other character is invalid.
            return true;
        }

        return false;
    }

    #cleanSentence(sentence) {
        // Convert the sentence to lowercase.
        let lowerCase = sentence.toLowerCase();

        // Remove all characters except a-z, 0-9, and space.
        let stripped = lowerCase.replace(/[^a-z0-9 ]/g, '');

        // Replace multiple consecutive spaces with a single space and trim the result.
        let cleaned = stripped.replace(/\s+/g, ' ').trim();

        return cleaned;
    }

    #constructSentence(numWordsBack) {
        const words = new Array(numWordsBack);
        for (let i = 0; i < numWordsBack; i++) {
            words[i] = this.buffer[(this.start + i) % this.maxWords];
        }

        let current = this.current;

        let flat = words.length > 0 ? words.join(' ') : '';
        if (current.length > 0) {
            const sep = flat.length > 0 ? ' ' : '';
            flat = flat + sep + current;
        }

        return flat;
    }

    // Testing function (unit tests)
    flatten(numWordsBack) {
        numWordsBack = Math.max(numWordsBack, 0);
        numWordsBack = Math.min(numWordsBack, this.size);

        return this.#constructSentence(numWordsBack);
    }

    // Testing function (unit tests)
    getTestSentence() {
        return this.#constructSentence(this.size);
    }

    // Interim transcripts are not added to the history. They just replace the current sentence.
    // If the previous transcript was final, the current sentence is split into maxWords and added
    // to the history.
    push(transcript, isFinal) {
        // PUBLIC METHOD
        if (!transcript) return; // Nothing to add

        // Check to see if the sentence needs to be cleaned. We want to minimize the number of allocations
        // in the common case where no cleaning is needed.
        const cleaned = this.#needsCleaning(transcript) ? this.#cleanSentence(transcript) : transcript;
        if (!cleaned) return; // Nothing to add

        let current = this.current;
        let maxWords = this.maxWords;

        // Split previous FINAL current sentence and extract the last maxWords.
        if (this.lastWasFinal && current.length > 0) {
            const words = current.split(' ');

            const length = Math.min(words.length, maxWords);
            const start = words.length - length;

            for (let i = start; i < length; i++) {
                const word = words[i];
                if (this.size >= this.maxWords) {
                    // Common case first. Buffer full: overwrite the oldest word and advance the start pointer.
                    this.buffer[this.start] = word;
                    this.start = (this.start + 1) % this.maxWords;
                } else {
                    // Append to the end.
                    this.buffer[(this.start + this.size) % this.maxWords] = word;
                    this.size++;
                }
            }
        }

        this.current = cleaned;
        this.lastWasFinal = isFinal;
        this.dirty = true;
    }

    findScamPhrases() {
        // PUBLIC METHOD
        // Calling findScamPhrases a second time on the same history
        // returns null to avoid multiple hits on the same data
        if (!this.dirty) return null;

        const flat = this.#constructSentence(this.size);
        let hit = this.finder.containsAny(flat);
        this.dirty = false;
        return hit;
    }

    // Remove all phrases that end up calling this command. This is for
    // one-shot style commands
    removeCommand(command) {
        // PUBLIC METHOD
        this.finder.removeByType(command);
    }

    reset() {
        // PUBLIC METHOD
        // Reset the circular buffer and other variables.
        this.start = 0; // Points to the oldest element.
        this.size = 0; // Number of words currently stored.
        this.current = ''; // current sentence to scan.
        this.dirty = false; // Anything new to check?
        this.lastWasFinal = true; // Was the last transcript pushed to history 'final'
    }
}

module.exports = TranscriptHistory;
