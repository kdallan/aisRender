const AHO_NODE_SIZE = 27; // Constant for node children count

function createNode() {
  return {
    goto: new Array(AHO_NODE_SIZE).fill(null),
    fail: null,
    output: []
  };
}

function charToIndex(c) {
  return (c === ' ') ? 26 : (c.charCodeAt(0) - 97);
}

class AhoCorasick {
  /**
   * Build an Aho–Corasick automaton from an array of phrase objects.
   * Each object should have at least `phrase` and `type` properties.
   * @param {{phrase: string, type: string, command?: object}[]} phrases
   */
  constructor(phrases) {
    // Filter and normalize phrases.
    this.phrases = [];
    this.patternLengths = [];
    for (let i = 0, len = phrases.length; i < len; i++) {
      const p = phrases[i];
      const norm = p.phrase.trim();
      if (norm.length) {
        // Copy the object and replace phrase with normalized version.
        this.phrases.push({ ...p, phrase: norm });
        this.patternLengths.push(norm.length);
      }
    }

    // Create root node.
    this.root = createNode();

    // Build trie.
    this.buildGotoFunction();
    // Build failure links and merge outputs.
    this.buildFailureAndOutputFunctions();
  }

  buildGotoFunction() {
    const phrases = this.phrases;
    const root = this.root;
    const ALPHA_SIZE = AHO_NODE_SIZE;

    for (let i = 0, pLen = phrases.length; i < pLen; i++) {
      let current = root;
      const pattern = phrases[i].phrase;
      const patLen = pattern.length;
      for (let j = 0; j < patLen; j++) {
        const idx = charToIndex(pattern[j]);
        if (current.goto[idx] === null) {
          current.goto[idx] = createNode();
        }
        current = current.goto[idx];
      }
      // Mark the end of the pattern.
      current.output.push(i);
    }
  }

  buildFailureAndOutputFunctions() {
    const root = this.root;
    root.fail = root;
    const ALPHA_SIZE = AHO_NODE_SIZE;
    const queue = [];
    let head = 0, tail = 0;

    // Initialize queue with root's direct children.
    for (let i = 0; i < ALPHA_SIZE; i++) {
      const child = root.goto[i];
      if (child !== null) {
        child.fail = root;
        queue[tail++] = child;
      }
    }

    // Process the queue with BFS.
    while (head < tail) {
      const current = queue[head++];
      for (let i = 0; i < ALPHA_SIZE; i++) {
        const child = current.goto[i];
        if (child === null) continue;
        queue[tail++] = child;

        let failState = current.fail;
        while (failState !== root && failState.goto[i] === null) {
          failState = failState.fail;
        }
        child.fail = failState.goto[i] || root;

        // Merge output from the fail state.
        if (child.fail.output.length) {
          child.output.push(...child.fail.output);
        }
      }
    }
  }

  /**
   * Return an array of all pattern matches in the given text.
   * Each match is returned as a JSON object with its meta-data.
   * @param {string} text  // text should be normalized: lower-case and [a-z ] only.
   * @returns {Array<{phrase: string, type: string, [command]?: object}>}
   */
  search(text) {
    if (!text) return [];
    const matches = [];
    const root = this.root;
    const phrases = this.phrases;
    const patLens = this.patternLengths;
    let current = root;
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const idx = charToIndex(text[i]);
      while (current !== root && current.goto[idx] === null) {
        current = current.fail;
      }
      current = current.goto[idx] || current;
      if (current.output.length) {
        const outputs = current.output;
        for (let k = 0, outLen = outputs.length; k < outLen; k++) {
          const pi = outputs[k];
          // We could use patLens[pi] if needed, but not used in this return.
          const pObj = phrases[pi];
          matches.push({
            phrase: pObj.phrase,
            type: pObj.type,
            ...(pObj.command && { command: pObj.command })
          });
        }
      }
    }
    return matches;
  }

  /**
   * Return a JSON object for the first found pattern match in the given text.
   * If no match is found, returns undefined.
   * The text is guaranteed to contain only [a-z ].
   * @param {string} text
   * @returns {{ phrase: string, type: string, [command]?: object } | undefined}
   */
  containsAny(text) {
    if (!text) return null;
    const root = this.root;
    const phrases = this.phrases;
    const patLens = this.patternLengths;
    let current = root;
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const idx = charToIndex(text[i]);
      while (current !== root && current.goto[idx] === null) {
        current = current.fail;
      }
      current = current.goto[idx] || current;
      if (current.output.length) {
        const pi = current.output[0];
        const pObj = phrases[pi];
        return {
          phrase: pObj.phrase,
          type: pObj.type,
          ...(pObj.command && { command: pObj.command })
        };
      }
    }
    return null;
  }
}

module.exports = AhoCorasick;
