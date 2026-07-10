import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  // Default timeout for all API requests. Without this, requests to an
  // unreachable backend hang for the OS TCP retransmission timeout (~75s on
  // iOS) before failing — making the PWA appear frozen for over a minute.
  // 15s is generous for slow mobile networks; long-running uploads override
  // this per-request.
  timeout: 15000,
});

export { default as axios } from "axios";
export const isAxiosError = axios.isAxiosError;
export default api;
