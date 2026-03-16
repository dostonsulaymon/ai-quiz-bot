import mongoose, { model, Schema, type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";

const leaderboardEntrySchema = new Schema({
  testId: {
    type: Schema.Types.ObjectId,
    ref: "Test",
    required: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  firstName: {
    type: String,
    required: true
  },
  score: {
    type: Number,
    required: true
  },
  correctCount: {
    type: Number,
    required: true
  },
  totalQuestions: {
    type: Number,
    required: true
  },
  timeTakenSeconds: {
    type: Number,
    required: true,
    default: 0
  },
  completedAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, {
  timestamps: false
});

leaderboardEntrySchema.index({ testId: 1, score: -1, timeTakenSeconds: 1 });
leaderboardEntrySchema.index({ testId: 1, userId: 1 }, { unique: true });

export type LeaderboardEntry = InferSchemaType<typeof leaderboardEntrySchema> & {
  _id: Types.ObjectId;
};
export type LeaderboardEntryDocument = HydratedDocument<LeaderboardEntry>;
type LeaderboardEntryModel = Model<LeaderboardEntry>;

export const LeaderboardEntryModel =
  (mongoose.models.LeaderboardEntry as LeaderboardEntryModel | undefined) ??
  model<LeaderboardEntry>("LeaderboardEntry", leaderboardEntrySchema);
