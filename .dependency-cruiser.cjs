// Keep the executable guard and dependency-cruiser on the same metadata-derived rules.
const { createMessagingDependencyConfig } = require("./scripts/lib/messaging-dependency-rules.mts");

module.exports = createMessagingDependencyConfig(__dirname);
