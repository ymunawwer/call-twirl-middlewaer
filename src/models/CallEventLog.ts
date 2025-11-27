import { Schema, model, Document } from "mongoose";



const CallEventLogSchema = new Schema(
  {
    event: { type: String},
    sequenceNumber: { type: String },
    streamSid: { type: String },
    rawPayload: { type: Schema.Types.Mixed },
  },
  {strict:false,
    timestamps: true,
  }
);

export const CallEventLog = model(
  "CallEventLog",
  CallEventLogSchema
);
