'use strict';
const AhoCorasick = require('./ahocorasick');
const pino = require('pino');
const log = pino({ base: null });

// Single regex to replace any non-alphanumeric sequence (excluding numbers) with a space.
const CLEAN_REGEX = /[^a-z0-9]+/g;

/**
 * Creates a scam phrase detector using the Aho-Corasick algorithm.
 * @param {Object[]} phrases - Each object must have a `phrase` property.
 * @returns {Object} - Detector with two methods: containsScamPhrase and findScamPhrases.
 */
function createScamDetector(phrases) {
    const ac = new AhoCorasick(phrases);
    return {
        containsScamPhrase: (text) => ac.containsAny(text),
        findScamPhrases: (text) => ac.search(text),
    };
}

class TranscriptHistory {
    constructor(phrases) {
        this.finder = createScamDetector(phrases);
        // Determine the maximum number of words needed based on the longest phrase.
        this.maxWords = Math.max(1, this.#longestPhraseInWords(phrases));

        log.info(`TranscriptHistory: maxWords = ${this.maxWords}`);

        // Set up a circular buffer to avoid costly shift() calls.
        this.buffer = new Array(this.maxWords);
        this.start = 0; // Points to the oldest element.
        this.size = 0; // Number of words currently stored.
    }

    /**
     * Pushes new transcript text into the rolling circular buffer.
     * @param {string} transcript
     */
    push(transcript) {
        // PUBLIC METHOD
        if (!transcript) return;
        // Clean and normalize in one pass: lowercase, collapse non-alphanumerics to a space, trim.
        const cleaned = transcript.toLowerCase().replace(CLEAN_REGEX, ' ').trim();
        if (!cleaned) return;

        // Split cleaned text on whitespace.
        const words = cleaned.split(' ');
        for (let i = 0, len = words.length; i < len; i++) {
            const word = words[i];
            if (this.size < this.maxWords) {
                // Append to the end.
                this.buffer[(this.start + this.size) % this.maxWords] = word;
                this.size++;
            } else {
                // Buffer full: overwrite the oldest word and advance the start pointer.
                this.buffer[this.start] = word;
                this.start = (this.start + 1) % this.maxWords;
            }
        }
    }

    /**
     * Checks whether the current buffer contains any scam phrase.
     * @returns {boolean}
     */
    findScamPhrases() {
        if (this.size === 0) return false;
        // Reconstruct the current text from the circular buffer.
        const words = new Array(this.size);
        for (let i = 0; i < this.size; i++) {
            words[i] = this.buffer[(this.start + i) % this.maxWords];
        }
        const flat = words.join(' ');
        return this.finder.containsScamPhrase(flat);
    }

    /**
     * Returns a flattened string of the last `numWordsBack` words.
     * If numWordsBack is <= 0, returns only the last word.
     * @param {number} numWordsBack
     * @returns {string}
     */
    flatten(numWordsBack) {
        if (this.size === 0) return '';
        if (numWordsBack <= 0) {
            return this.buffer[(this.start + this.size - 1) % this.maxWords];
        }

        const count = Math.min(numWordsBack, this.size);
        let result = '';

        for (let i = 0; i < count; i++) {
            if (i > 0) result += ' ';
            result += this.buffer[(this.start + this.size - count + i) % this.maxWords];
        }

        return result;
    }

    reset() {
        this.buffer = new Array(this.maxWords);
        this.start = 0;
        this.size = 0;
    }

    /**
     * Computes the maximum number of words in any phrase.
     * @param {Object[]} phrases
     * @returns {number}
     */
    #longestPhraseInWords(phrases) {
        let max = 0;
        for (let i = 0, len = phrases.length; i < len; i++) {
            // Trim once and split on whitespace.
            const count = phrases[i].phrase.trim().split(/\s+/).length;
            if (count > max) max = count;
        }
        return max;
    }
}

module.exports = TranscriptHistory;
