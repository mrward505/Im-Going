/**
 * Auth token storage — expo-secure-store on native, AsyncStorage on web.
 * A single "session token" (JWT from login/register) plus cached user JSON.
 */
import { Platform } from "react-native";

const TOKEN_KEY = "imgoing.session_token";
const USER_KEY = "imgoing.session_user";

// Web fallback abstraction so this module has one tiny native import surface.
type WebStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

let secureStore: typeof import("expo-secure-store") | null = null;
let asyncStorage: WebStore | null = null;

function isWeb(): boolean {
  return Platform.OS === "web";
}

export async function getToken(): Promise<string | null> {
  try {
    if (isWeb()) {
      if (!asyncStorage) {
        asyncStorage = (await import("@react-native-async-storage/async-storage"))
          .default as unknown as WebStore;
      }
      return (await asyncStorage.getItem(TOKEN_KEY)) ?? null;
    }
    if (!secureStore) {
      secureStore = await import("expo-secure-store");
    }
    return await secureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  if (isWeb()) {
    if (!asyncStorage) {
      asyncStorage = (await import("@react-native-async-storage/async-storage"))
        .default as unknown as WebStore;
    }
    await asyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  if (!secureStore) {
    secureStore = await import("expo-secure-store");
  }
  await secureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  try {
    if (isWeb()) {
      if (!asyncStorage) {
        asyncStorage = (await import("@react-native-async-storage/async-storage"))
          .default as unknown as WebStore;
      }
      await asyncStorage.removeItem(TOKEN_KEY);
      await asyncStorage.removeItem(USER_KEY);
      return;
    }
    if (!secureStore) {
      secureStore = await import("expo-secure-store");
    }
    await secureStore.deleteItemAsync(TOKEN_KEY);
    await secureStore.deleteItemAsync(USER_KEY);
  } catch {
    // best-effort
  }
}

export async function getCachedUser<T>(): Promise<T | null> {
  try {
    if (isWeb()) {
      if (!asyncStorage) {
        asyncStorage = (await import("@react-native-async-storage/async-storage"))
          .default as unknown as WebStore;
      }
      const raw = await asyncStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    if (!secureStore) {
      secureStore = await import("expo-secure-store");
    }
    const raw = await secureStore.getItemAsync(USER_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function setCachedUser<T>(user: T): Promise<void> {
  const raw = JSON.stringify(user);
  if (isWeb()) {
    if (!asyncStorage) {
      asyncStorage = (await import("@react-native-async-storage/async-storage"))
        .default as unknown as WebStore;
    }
    await asyncStorage.setItem(USER_KEY, raw);
    return;
  }
  if (!secureStore) {
    secureStore = await import("expo-secure-store");
  }
  await secureStore.setItemAsync(USER_KEY, raw);
}