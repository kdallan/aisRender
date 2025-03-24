function createNode() {
    // Each node has an array of length 27:
    // 0..25 => 'a'..'z', 26 => ' ' (space)
    return {
        goto: new Array(27).fill(null),
        fail: null,
        output: []
    };
}

/**
 * Map a character in [a-z ] to an integer [0..26].
 * 'a' -> 0, 'b' -> 1, ..., 'z' -> 25, ' ' -> 26
 */
function charToIndex(c) {
    return (c === ' ') ? 26 : (c.charCodeAt(0) - 97);
}

class AhoCorasick {
    /**
     * Build an Aho-Corasick automaton from an array of patterns,
     * each guaranteed to be [a-z ] only.
     * @param {string[]} patterns
     */
    constructor(patterns) {
        this.patterns = [];
        this.patternLengths = [];

        // Normalize and store valid patterns
        for (const p of patterns) {
            const norm = p.trim(); // guaranteed lower + space
            if (norm.length > 0) {
                this.patterns.push(norm);
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

    /**
     * Build the trie transitions (goto function)
     */
    buildGotoFunction() {
        const { patterns, root } = this;

        for (let i = 0; i < patterns.length; i++) {
            let current = root;
            const pattern = patterns[i];

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

    /**
     * Build the failure links and merge output from those failure states
     * using a BFS traversal.
     */
    buildFailureAndOutputFunctions() {
        const { root } = this;
        root.fail = root;

        // Pointer-based BFS queue
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

            // Check all possible transitions from 'current'
            for (let i = 0; i < 27; i++) {
                const child = current.goto[i];
                if (child === null) {
                    continue;
                }

                queue[tail++] = child;

                // Find the correct fail state
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
     * The text is guaranteed to contain only [a-z ].
     * @param {string} text
     * @returns {Array<{pattern: string, position: number}>}
     */
    search(text) {
        if (!text) return [];

        const matches = [];
        const { root, patterns, patternLengths } = this;

        let current = root;
        const len = text.length;

        for (let i = 0; i < len; i++) {
            const idx = charToIndex(text[i]);

            // Follow fail links if we can't move on idx
            while (current !== root && current.goto[idx] === null) {
                current = current.fail;
            }

            if (current.goto[idx]) {
                current = current.goto[idx];
            }

            // Check if this node outputs any pattern(s)
            if (current.output.length > 0) {
                for (const patternIndex of current.output) {
                    const patternLen = patternLengths[patternIndex];
                    matches.push({
                        pattern: this.patterns[patternIndex],
                        position: i - patternLen + 1
                    });
                }
            }
        }

        return matches;
    }

    /**
     * Return true if any pattern is found in the given text.
     * The text is guaranteed to contain only [a-z ].
     * @param {string} text
     * @returns {boolean}
     */
    containsAny(text) {
        if (!text) return false;

        const { root } = this;
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

            // If this node has any patterns, we're done
            if (current.output.length > 0) {
                return true;
            }
        }

        return false;
    }
}

module.exports = AhoCorasick;
