"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallLog = void 0;
const mongoose_1 = require("mongoose");
const CallLogSchema = new mongoose_1.Schema({
    Called: String,
    ToState: String,
    CallerCountry: String,
    Direction: String,
    CallerState: String,
    ToZip: String,
    CallSid: { type: String, required: true, index: true, unique: true },
    To: String,
    CallerZip: String,
    ToCountry: String,
    CalledZip: String,
    ApiVersion: String,
    CalledCity: String,
    CallStatus: String,
    From: String,
    AccountSid: { type: String, required: true, index: true },
    CalledCountry: String,
    CallerCity: String,
    ToCity: String,
    FromCountry: String,
    Caller: String,
    FromCity: String,
    CalledState: String,
    FromZip: String,
    FromState: String,
    callStartedAt: Date,
    callEndedAt: Date,
    rawPayload: mongoose_1.Schema.Types.Mixed,
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    strict: false,
});
CallLogSchema.virtual("durationSeconds").get(function () {
    if (!this.createdAt || !this.updatedAt)
        return undefined;
    const ms = this.updatedAt.getTime() - this.createdAt.getTime();
    if (!Number.isFinite(ms))
        return undefined;
    return Math.max(0, Math.round(ms / 1000));
});
exports.CallLog = (0, mongoose_1.model)("CallLog", CallLogSchema);
