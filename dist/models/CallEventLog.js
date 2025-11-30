"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallEventLog = void 0;
const mongoose_1 = require("mongoose");
const CallEventLogSchema = new mongoose_1.Schema({
    event: { type: String },
    sequenceNumber: { type: String },
    streamSid: { type: String },
    rawPayload: { type: mongoose_1.Schema.Types.Mixed },
}, { strict: false,
    timestamps: true,
});
exports.CallEventLog = (0, mongoose_1.model)("CallEventLog", CallEventLogSchema);
