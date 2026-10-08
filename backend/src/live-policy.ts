// One target for deadlines, retention and reporting; timing bases remain distinct.
export const deliveryTargetMs = 2000;
export const reconcileBatchSize = 100;
export const maxLiveConnections = 1000;
export const maxSubscriberQueue = 256;
export const maxPendingObservations = 512;
export const defaultReportingWindowMs = 24 * 60 * 60 * 1000;
export const maxReportingWindowMs = 7 * defaultReportingWindowMs;
export const maxReportRows = 50_000;
export const maxReportDetails = 100;
