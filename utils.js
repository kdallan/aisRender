'use strict';

function calculateAverage(array) {
    return array.length > 0 ? array.reduce((a, b) => a + b, 0) / array.length : 0;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

module.exports = {
    calculateAverage,
    formatBytes,
};