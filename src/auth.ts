import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp ms
  token_type: string;
  account_id: string;
  profile_id?: string;
}

export interface SessionInfo {
  email?: string;
  username?: string;
  account_id?: string;
  saved_at?: string;
}

export function getConfigDir(): string {
  return join(homedir(), ".strider", "crunchyroll");
}

const TOKEN_FILE = join(getConfigDir(), "tokens.json");
const SESSION_FILE = join(getConfigDir(), "session.json");

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
}

export async function saveTokens(tokens: TokenData): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

export async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

export async function saveSessionInfo(info: SessionInfo): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(SESSION_FILE, JSON.stringify({ ...info, saved_at: new Date().toISOString() }, null, 2));
}

export async function loadSessionInfo(): Promise<SessionInfo | null> {
  try {
    const data = await fs.readFile(SESSION_FILE, "utf-8");
    return JSON.parse(data) as SessionInfo;
  } catch {
    return null;
  }
}

export async function clearAuthData(): Promise<void> {
  await Promise.allSettled([
    fs.unlink(TOKEN_FILE),
    fs.unlink(SESSION_FILE),
  ]);
}

export async function hasSavedTokens(): Promise<boolean> {
  try {
    await fs.access(TOKEN_FILE);
    return true;
  } catch {
    return false;
  }
}

export function isTokenExpired(tokens: TokenData): boolean {
  return Date.now() >= tokens.expires_at - 60_000; // 1 min buffer
}
