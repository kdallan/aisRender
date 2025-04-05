'use strict';

const AHO_NODE_SIZE = 27; // 26 letters + space

function createNode() {
    // Defer creation of output array until actually needed to reduce memory overhead.
    return {
        goto: new Array(AHO_NODE_SIZE).fill(null),
        fail: null,
        output: null,
    };
}

class AhoCorasick {
    /**
     * Build an Aho–Corasick automaton from an array of phrase objects.
     * Each object should have at least `phrase` and `type` properties.
     * @param {{phrase: string, type: string, command?: object}[]} phrases
     */
    constructor(phrases) {
        // Preprocess and normalize phrases.
        const normalized = [];
        for (let i = 0; i < phrases.length; i++) {
            const p = phrases[i];
            const norm = p.phrase.trim();
            if (norm) {
                // Keep the entire object but with trimmed phrase.
                normalized.push({
                    ...p,
                    phrase: norm,
                });
            }
        }
        this.phrases = normalized;

        // Create root node.
        const root = createNode();
        this.root = root;

        // Build the trie (goto function).
        this.#buildGotoFunction();

        // Build failure links + merge outputs.
        this.#buildFailureAndOutputFunctions();
    }

    #buildGotoFunction() {
        const root = this.root;
        const phrases = this.phrases;
        // Inline charToIndex to avoid repeated function calls:
        // (c === ' ') ? 26 : (c.charCodeAt(0) - 97)

        for (let i = 0; i < phrases.length; i++) {
            let current = root;
            const pattern = phrases[i].phrase;
            for (let j = 0; j < pattern.length; j++) {
                const c = pattern[j];
                const idx = c === ' ' ? 26 : c.charCodeAt(0) - 97;

                let nextNode = current.goto[idx];
                if (nextNode === null) {
                    nextNode = createNode();
                    current.goto[idx] = nextNode;
                }
                current = nextNode;
            }
            // Instead of storing an index, store the phrase object directly in output.
            if (!current.output) {
                current.output = [phrases[i]];
            } else {
                current.output.push(phrases[i]);
            }
        }
    }

    #buildFailureAndOutputFunctions() {
        const root = this.root;
        root.fail = root;

        // BFS queue to build fail links
        const queue = [];
        let head = 0,
            tail = 0;

        // Init queue with all immediate children of root
        for (let i = 0; i < AHO_NODE_SIZE; i++) {
            const child = root.goto[i];
            if (child) {
                child.fail = root;
                queue[tail++] = child;
            } else {
                // Optional: for speed, link back to root when there's no child
                // so we skip some checks later
                root.goto[i] = root;
            }
        }

        while (head < tail) {
            const current = queue[head++];

            for (let i = 0; i < AHO_NODE_SIZE; i++) {
                let child = current.goto[i];
                if (!child) {
                    // If there's no child for this symbol, redirect to fail's child.
                    current.goto[i] = current.fail.goto[i];
                    continue;
                }

                queue[tail++] = child;

                // Find fail state
                let failState = current.fail;
                while (!failState.goto[i]) {
                    failState = failState.fail;
                }
                child.fail = failState.goto[i];

                // Merge output from the fail state
                if (child.fail.output) {
                    if (!child.output) {
                        child.output = child.fail.output.slice();
                    } else {
                        child.output.push(...child.fail.output);
                    }
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
        // PUBLIC METHOD
        if (!text) return [];
        const matches = [];
        const root = this.root;
        let current = root;

        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            const idx = c === ' ' ? 26 : c.charCodeAt(0) - 97;

            // Follow fail links until we find a valid goto
            while (!current.goto[idx]) {
                current = current.fail;
            }
            current = current.goto[idx];

            if (current.output) {
                // Gather outputs
                const out = current.output;
                for (let k = 0; k < out.length; k++) {
                    matches.push({
                        phrase: out[k].phrase,
                        type: out[k].type,
                        ...(out[k].command && { command: out[k].command }),
                    });
                }
            }
        }
        return matches;
    }

    /**
     * Return the first found pattern match (or null) in the given text.
     * The text is guaranteed to contain only [a-z ].
     * @param {string} text
     * @returns {{ phrase: string, type: string, [command]?: object } | null}
     */
    containsAny(text) {
        // PUBLIC METHOD
        if (!text) return null;
        const root = this.root;
        let current = root;

        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            const idx = c === ' ' ? 26 : c.charCodeAt(0) - 97;

            while (!current.goto[idx]) {
                current = current.fail;
            }
            current = current.goto[idx];

            if (current.output) {
                // Return the first match immediately
                const found = current.output[0];
                return {
                    phrase: found.phrase,
                    type: found.type,
                    ...(found.command && { command: found.command }),
                };
            }
        }
        return null;
    }

    /**
     * Remove a phrase from the automaton.
     * @param {string} phraseToRemove - The phrase to remove (should be normalized, e.g. trimmed).
     */
    remove(phraseToRemove) {
        // PUBLIC METHOD
        // Traverse the trie to update output arrays.
        // We use a BFS traversal while keeping track of visited nodes to avoid processing nodes multiple times.
        const visited = new Set();
        const queue = [this.root];
        visited.add(this.root);

        while (queue.length > 0) {
            const node = queue.shift();

            // If this node has an output array, filter out the phrase.
            if (node.output) {
                node.output = node.output.filter((p) => p.phrase !== phraseToRemove);
                if (node.output.length === 0) {
                    node.output = null;
                }
            }

            // Enqueue all children (avoid revisiting nodes).
            for (let i = 0; i < AHO_NODE_SIZE; i++) {
                const child = node.goto[i];
                if (child && !visited.has(child)) {
                    visited.add(child);
                    queue.push(child);
                }
            }
        }
    }

    /**
     * Remove all phrases from the automaton that match a given type.
     * @param {string} typeToRemove - The type identifier to remove (e.g. 'cmd:talkToSID').
     */
    removeByType(typeToRemove) {
        // Use BFS to traverse the trie and update output arrays.
        const visited = new Set();
        const queue = [this.root];
        visited.add(this.root);

        while (queue.length > 0) {
            const node = queue.shift();

            // If this node has an output array, filter out phrases with the given type.
            if (node.output) {
                node.output = node.output.filter((p) => p.type !== typeToRemove);
                if (node.output.length === 0) {
                    node.output = null;
                }
            }

            // Enqueue all child nodes (avoid revisiting nodes).
            for (let i = 0; i < AHO_NODE_SIZE; i++) {
                const child = node.goto[i];
                if (child && !visited.has(child)) {
                    visited.add(child);
                    queue.push(child);
                }
            }
        }
    }
}

module.exports = AhoCorasick;
