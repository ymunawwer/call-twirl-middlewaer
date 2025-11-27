import { Schema, model, Document } from "mongoose";

export interface CallLogDocument extends Document {
  Called?: string;
  ToState?: string;
  CallerCountry?: string;
  Direction?: string;
  CallerState?: string;
  ToZip?: string;
  CallSid: string;
  To?: string;
  CallerZip?: string;
  ToCountry?: string;
  CalledZip?: string;
  ApiVersion?: string;
  CalledCity?: string;
  CallStatus?: string;
  From?: string;
  AccountSid: string;
  CalledCountry?: string;
  CallerCity?: string;
  ToCity?: string;
  FromCountry?: string;
  Caller?: string;
  FromCity?: string;
  CalledState?: string;
  FromZip?: string;
  FromState?: string;
  rawPayload?: any;
  callStartedAt?: Date;
  callEndedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  durationSeconds?: number;
}

const CallLogSchema = new Schema<CallLogDocument>(
  {
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
    rawPayload: Schema.Types.Mixed,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    strict: false,
  }
);

CallLogSchema.virtual("durationSeconds").get(function (this: CallLogDocument) {
  if (!this.createdAt || !this.updatedAt) return undefined;
  const ms = this.updatedAt.getTime() - this.createdAt.getTime();
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.round(ms / 1000));
});

export const CallLog = model<CallLogDocument>("CallLog", CallLogSchema);
