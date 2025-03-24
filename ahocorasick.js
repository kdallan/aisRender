function createNode() {
    return {
        goto: new Array(27).fill(null),
        fail: null,
        output: []
    };
}

function charToIndex(c) {
    return (c === ' ') ? 26 : (c.charCodeAt(0) - 97);
}

class AhoCorasick {
    /**
     * Build an Aho-Corasick automaton from an array of phrase objects.
     * Each object should have at least `phrase` and `type` properties.
     * @param {{phrase: string, type: string, command?: object}[]} phrases
     */
    constructor(phrases) {
        // Store objects and their phrase lengths
        this.phrases = [];
        this.patternLengths = [];

        for (const p of phrases) {
            const norm = p.phrase.trim();
            if (norm.length > 0) {
                // Store a copy with normalized phrase
                this.phrases.push({ ...p, phrase: norm });
                this.patternLengths.push(norm.length);
            }
        }

        // Create root node
        this.root = createNode();

        // Build trie (goto function)
        this.buildGotoFunction();

        // Build failure links and merge outputs
        this.buildFailureAndOutputFunctions();
    }

    buildGotoFunction() {
        const { phrases, root } = this;

        for (let i = 0; i < phrases.length; i++) {
            let current = root;
            const pattern = phrases[i].phrase;
            for (let j = 0; j < pattern.length; j++) {
                const idx = charToIndex(pattern[j]);
                if (current.goto[idx] === null) {
                    current.goto[idx] = createNode();
                }
                current = current.goto[idx];
            }
            // Mark this node as the end of the i-th pattern
            current.output.push(i);
        }
    }

    buildFailureAndOutputFunctions() {
        const { root } = this;
        root.fail = root;

        const queue = [];
        let head = 0, tail = 0;

        // Initialize the queue with direct children of root
        for (let i = 0; i < 27; i++) {
            const child = root.goto[i];
            if (child !== null) {
                child.fail = root;
                queue[tail++] = child;
            }
        }

        // BFS
        while (head < tail) {
            const current = queue[head++];
            for (let i = 0; i < 27; i++) {
                const child = current.goto[i];
                if (child === null) continue;
                queue[tail++] = child;

                let failState = current.fail;
                while (failState !== root && failState.goto[i] === null) {
                    failState = failState.fail;
                }
                child.fail = failState.goto[i] || root;

                // Merge output from fail state
                if (child.fail.output.length > 0) {
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
        const { root, phrases, patternLengths } = this;
        let current = root;
        const len = text.length;

        for (let i = 0; i < len; i++) {
            const idx = charToIndex(text[i]);
            while (current !== root && current.goto[idx] === null) {
                current = current.fail;
            }
            if (current.goto[idx]) {
                current = current.goto[idx];
            }
            if (current.output.length > 0) {
                for (const patternIndex of current.output) {
                    const patternLen = patternLengths[patternIndex];
                    // Return the entire phrase object with additional match info
                    matches.push({
                        phrase: phrases[patternIndex].phrase,
                        type: phrases[patternIndex].type,
                        ...(phrases[patternIndex].command ? { command: phrases[patternIndex].command } : {})
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
    if (!text) return undefined;
    const { root, phrases, patternLengths } = this;
    let current = root;
    const len = text.length;

    for (let i = 0; i < len; i++) {
        const idx = charToIndex(text[i]);
        while (current !== root && current.goto[idx] === null) {
            current = current.fail;
        }
        if (current.goto[idx]) {
            current = current.goto[idx];
        }
        if (current.output.length > 0) {
            // Return the first matching phrase as JSON
            const patternIndex = current.output[0];
            const patternLen = patternLengths[patternIndex];
            return {
                phrase: phrases[patternIndex].phrase,
                type: phrases[patternIndex].type,
                ...(phrases[patternIndex].command ? { command: phrases[patternIndex].command } : {})
            };
        }
    }
    return null;
}

}

module.exports = AhoCorasick;
