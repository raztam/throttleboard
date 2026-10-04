import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";

const playerSchema = new Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  highScore: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export type Player = InferSchemaType<typeof playerSchema> & {
  _id: Types.ObjectId;
};

export const Player = mongoose.model("Player", playerSchema);
