import mongoose from "mongoose";
import { config } from "../config/index.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const connectToDatabase = async (): Promise<typeof mongoose> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      console.info(`[db] Connecting to MongoDB (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const connection = await mongoose.connect(config.MONGODB_URI);
      console.info("[db] MongoDB connection established");
      return connection;
    } catch (error) {
      lastError = error;
      console.error(`[db] MongoDB connection failed on attempt ${attempt}/${MAX_ATTEMPTS}`, error);

      if (attempt < MAX_ATTEMPTS) {
        console.info(`[db] Retrying MongoDB connection in ${RETRY_DELAY_MS / 1000}s`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  console.error("[db] MongoDB connection failed after maximum retry attempts");
  throw lastError;
};

mongoose.connection.on("connected", () => {
  console.info("[db] Mongoose connected");
});

mongoose.connection.on("disconnected", () => {
  console.warn("[db] Mongoose disconnected");
});

mongoose.connection.on("error", (error) => {
  console.error("[db] Mongoose connection error", error);
});
