import mongoose, { model, Schema, type HydratedDocument, type InferSchemaType, type Model, type Types } from "mongoose";

const classSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    testIds: {
      type: [Schema.Types.ObjectId],
      ref: "Test",
      default: []
    },
    shareCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

classSchema.index({ creatorId: 1 });
classSchema.index({ shareCode: 1 }, { unique: true, sparse: true });

export type Class = InferSchemaType<typeof classSchema> & {
  _id: Types.ObjectId;
};

export type ClassDocument = HydratedDocument<Class>;
type ClassModel = Model<Class>;

export const ClassModel = (mongoose.models.Class as ClassModel | undefined) ?? model<Class>("Class", classSchema);
