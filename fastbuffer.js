'use strict';
const pino = require('pino');
const log = pino({ base: null });

function nextPowerOfTwo(num) {
    if (num <= 0) {
        return 1;
    }
    let power = 1;
    while (power < num) {
        power *= 2;
    }
    return power;
}

class FastBuffer {
    constructor(size) {
        this.buffer = Buffer.allocUnsafe( nextPowerOfTwo( size ));
        this.offset = 0;
    }

    append(chunk) {
    	if( !chunk || chunk.length === 0 ) return;
        
        let total = this.offset + chunk.length
        if (total > this.buffer.length) {

            const nextpow2 = nextPowerOfTwo( total );
            log.warn( 'FastBuffer:append - resizing buffer from', this.buffer.length, 'to', nextpow2);
            let newBuffer = Buffer.alloc( nextpow2 );
            this.buffer.copy(newBuffer);
            this.buffer = newBuffer; // TODO: create a buffer pool
        }
        
        chunk.copy( this.buffer, this.offset);
        this.offset += chunk.length;
    }

    getBuffer() {
        return this.buffer.subarray(0, this.offset);
    }

    reset() {
        this.offset = 0;
    }

    length() {
        return this.offset;
    }
}

module.exports = {
    FastBuffer,
};
