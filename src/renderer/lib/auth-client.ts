import { createAuthClient } from "better-auth/react";
import type { auth } from "../../../private-service/src/modules/auth/auth";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
});

export type Session = typeof authClient.$Infer.Session;
