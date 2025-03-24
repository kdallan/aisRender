const AhoCorasick = require('./ahocorasick');

/**
 * Creates a scam phrase detector using the Aho-Corasick algorithm
 * @param {string[]} phrases - Phrases to detect
 * @returns {Object} - Detector with methods to check text
 */
function createScamDetector(phrases) {
  const ac = new AhoCorasick(phrases);
  return {
    containsScamPhrase(text) {
      return ac.containsAny(text);
    },
    findScamPhrases(text) {
      return ac.search(text);
    },
  };
}

class TranscriptHistory {
  constructor(phrases) {
    this.finder = createScamDetector(phrases);
    // We'll keep up to the length (in words) of the longest scam phrase.
    this.maxWords = Math.max(1, this._longestPhraseInWords(phrases));

    // Rolling buffer of words
    this.buffer = [];
  }
  
  /**
   * Pushes new transcript text into the rolling buffer
   * @param {string} transcript 
   */
  push(transcript) {
    // Normalize
    const cleaned = transcript
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!cleaned) return;
    
    // Split into words and append
    const words = cleaned.split(' ');
    this.buffer.push(...words);
    
    // Keep only the last 'maxWords' words
    while (this.buffer.length > this.maxWords) {
      this.buffer.shift();
    }
  }
  
  /**
   * Checks whether the last words in buffer form a text
   * containing any scam phrase
   * @returns {boolean}
   */
  findScamPhrases() {
    if (!this.buffer.length) return false;
    // Join into a single string
    const flat = this.buffer.join(' ');
    return this.finder.containsScamPhrase(flat);
  }
  
  /**
   * Returns a flattened string of the last `numWordsBack` words
   * (for debugging or inspection)
   * @param {number} numWordsBack - number of words from the end
   * @returns {string}
   */
  flatten(numWordsBack) {
    // If buffer is empty, just return ""
    if (!this.buffer.length) {
      return '';
    }

    // If numWordsBack <= 0, return the last word (or handle negative however you like)
    if (numWordsBack <= 0) {
      return this.buffer[this.buffer.length - 1];
    }
    
    // Otherwise, slice from the end
    const startIndex = Math.max(0, this.buffer.length - numWordsBack);
    return this.buffer.slice(startIndex).join(' ');
  }
  
  /**
   * Returns the length in words of the longest phrase in `phrases`
   * @param {string[]} phrases 
   * @returns {number}
   */
  _longestPhraseInWords(phrases) {
    let max = 0;
    for (const phrase of phrases) {
      const count = phrase.phrase.trim().split(/\s+/).length;
      if (count > max) max = count;
    }
    return max;
  }
}

module.exports = TranscriptHistory;
