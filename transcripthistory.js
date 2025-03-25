const AhoCorasick = require('./ahocorasick');

// Precompile regex patterns to avoid re-creating them on every call.
const NON_ALPHANUM = /[^a-z0-9\s]/g;
const WHITESPACE = /\s+/g;

/**
 * Creates a scam phrase detector using the Aho-Corasick algorithm
 * @param {Object[]} phrases - Array of objects with a `phrase` property.
 * @returns {Object} - Detector with methods to check text.
 */
function createScamDetector(phrases) {
  const ac = new AhoCorasick(phrases);
  return {
    containsScamPhrase: text => ac.containsAny(text),
    findScamPhrases: text => ac.search(text),
  };
}

class TranscriptHistory {
  constructor(phrases) {
    this.finder = createScamDetector(phrases);
    // Compute maximum words from phrases. We assume each element has a 'phrase' property.
    this.maxWords = Math.max(1, this._longestPhraseInWords(phrases));
    this.buffer = [];
  }

  /**
   * Pushes new transcript text into the rolling buffer.
   * @param {string} transcript 
   */
  push(transcript) {
    // Normalize and clean the text in one pass.
    let cleaned = transcript.toLowerCase().replace(NON_ALPHANUM, '').replace(WHITESPACE, ' ').trim();
    if (!cleaned) return;

    // Split into words.
    const words = cleaned.split(' ');
    // Use push.apply for efficiency if words array is large.
    this.buffer.push(...words);

    // Remove older words until buffer length does not exceed maxWords.
    // Using while-loop avoids creating a new array.
    while (this.buffer.length > this.maxWords) {
      this.buffer.shift();
    }
  }

  /**
   * Checks whether the current buffer contains any scam phrase.
   * @returns {boolean}
   */
  findScamPhrases() {
    if (!this.buffer.length) return false;
    // Join the buffer into a string only when needed.
    const flat = this.buffer.join(' ');
    return this.finder.containsScamPhrase(flat);
  }

  /**
   * Returns a flattened string of the last `numWordsBack` words.
   * @param {number} numWordsBack 
   * @returns {string}
   */
  flatten(numWordsBack) {
    const len = this.buffer.length;
    if (!len) return '';
    if (numWordsBack <= 0) return this.buffer[len - 1];
    const startIndex = len - numWordsBack;
    return this.buffer.slice(startIndex < 0 ? 0 : startIndex).join(' ');
  }

  /**
   * Returns the length in words of the longest phrase.
   * @param {Object[]} phrases 
   * @returns {number}
   */
  _longestPhraseInWords(phrases) {
    let max = 0;
    for (let i = 0, len = phrases.length; i < len; i++) {
      // Cache trimmed string and split once.
      const count = phrases[i].phrase.trim().split(WHITESPACE).length;
      if (count > max) max = count;
    }
    return max;
  }
}

module.exports = TranscriptHistory;
