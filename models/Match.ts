import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";

const matchSchema = new Schema({
  playerId: {
    type: Schema.Types.ObjectId,
    ref: "Player",
    required: true,
  },
  score: { type: Number, required: true },
  playedAt: { type: Date, default: Date.now },
});

export type Match = InferSchemaType<typeof matchSchema> & {
  _id: Types.ObjectId;
};

export const Match = mongoose.model("Match", matchSchema);
