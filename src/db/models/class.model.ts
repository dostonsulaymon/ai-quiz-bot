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
      required: true
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


export type Class = InferSchemaType<typeof classSchema> & {
  _id: Types.ObjectId;
};

export type ClassDocument = HydratedDocument<Class>;
type ClassModel = Model<Class>;

export const ClassModel = (mongoose.models.Class as ClassModel | undefined) ?? model<Class>("Class", classSchema);
