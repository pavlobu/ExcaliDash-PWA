import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { DrawingSortField, SortDirection } from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import { isLatestRequest, mergeUniqueDrawings } from "./pagination";
import {
  cacheDrawingSummaries,
  cacheCollections,
  getCachedDrawingSummaries,
  getCachedCollections,
} from "../../db/offline-db";

type SelectedCollectionId = string | null | undefined;

type UseDashboardDataOptions = {
  debouncedSearch: string;
  selectedCollectionId: SelectedCollectionId;
  sortField: DrawingSortField;
  sortDirection: SortDirection;
  pageSize: number;
  onRefreshSuccess?: () => void;
};

export const useDashboardData = ({
  debouncedSearch,
  selectedCollectionId,
  sortField,
  sortDirection,
  pageSize,
  onRefreshSuccess,
}: UseDashboardDataOptions) => {
  const [drawings, setDrawings] = useState<DrawingSummary[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const listRequestVersionRef = useRef(0);
  const nextOffsetRef = useRef(0);

  const hasMore = drawings.length < totalCount;

  const refreshData = useCallback(async () => {
    const requestVersion = ++listRequestVersionRef.current;

    // Show cached data from IndexedDB immediately so the dashboard renders
    // instantly on offline/standalone PWA launches. Without this, the UI
    // blocks on the API calls which take up to 15s (api timeout) to fail
    // when the backend is unreachable.
    let hadCachedData = false;
    try {
      const [cachedDrawings, cachedCollections] = await Promise.all([
        getCachedDrawingSummaries(),
        getCachedCollections(),
      ]);
      if (cachedDrawings.length > 0) {
        const filtered = debouncedSearch
          ? cachedDrawings.filter((d) =>
              d.name.toLowerCase().includes(debouncedSearch.toLowerCase())
            )
          : cachedDrawings;
        setDrawings(filtered);
        setTotalCount(filtered.length);
        nextOffsetRef.current = filtered.length;
        hadCachedData = true;
      }
      if (cachedCollections.length > 0) {
        setCollections(cachedCollections);
      }
    } catch {
      // IndexedDB unavailable
    }

    // Only show the loading spinner if there's no cached data to display.
    if (!hadCachedData) {
      setIsLoading(true);
    }

    // When offline, skip all API calls. The cached IndexedDB data (shown
    // above) is the best we can do. Without this guard, each API call hangs
    // for 15s (axios timeout), making the dashboard feel frozen.
    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
    if (isOffline) {
      if (isLatestRequest(requestVersion, listRequestVersionRef.current)) {
        setIsLoading(false);
      }
      return;
    }

    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsPromise = isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: 0,
            sortField,
            sortDirection,
          });

      const [drawingsResult, collectionsResult] = await Promise.allSettled([
        drawingsPromise,
        api.getCollections(),
      ]);
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current))
        return;

      if (drawingsResult.status === "fulfilled") {
        setDrawings(drawingsResult.value.drawings);
        setTotalCount(drawingsResult.value.totalCount);
        nextOffsetRef.current = drawingsResult.value.drawings.length;
        cacheDrawingSummaries(drawingsResult.value.drawings).catch(() => {});
        onRefreshSuccess?.();
      } else {
        console.error("Failed to fetch drawings:", drawingsResult.reason);
        try {
          const cached = await getCachedDrawingSummaries();
          if (cached.length > 0) {
            const filtered = debouncedSearch
              ? cached.filter((d) =>
                  d.name.toLowerCase().includes(debouncedSearch.toLowerCase())
                )
              : cached;
            setDrawings(filtered);
            setTotalCount(filtered.length);
            nextOffsetRef.current = filtered.length;
          }
        } catch {
          // IndexedDB unavailable
        }
      }

      if (collectionsResult.status === "fulfilled") {
        setCollections(collectionsResult.value);
        cacheCollections(collectionsResult.value).catch(() => {});
      } else {
        console.error("Failed to fetch collections:", collectionsResult.reason);
        try {
          const cachedCols = await getCachedCollections();
          if (cachedCols.length > 0) setCollections(cachedCols);
        } catch {
          // IndexedDB unavailable
        }
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      if (isLatestRequest(requestVersion, listRequestVersionRef.current)) {
        setIsLoading(false);
      }
    }
  }, [
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
    onRefreshSuccess,
  ]);

  const fetchMore = useCallback(async () => {
    if (isFetchingMore || !hasMore || isLoading) return;
    const requestVersion = listRequestVersionRef.current;
    setIsFetchingMore(true);
    try {
      const isSharedView = selectedCollectionId === "shared";
      const drawingsRes = await (isSharedView
        ? api.getSharedDrawings(debouncedSearch, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
          })
        : api.getDrawings(debouncedSearch, selectedCollectionId, {
            includePreview: true,
            limit: pageSize,
            offset: nextOffsetRef.current,
            sortField,
            sortDirection,
          }));
      if (!isLatestRequest(requestVersion, listRequestVersionRef.current))
        return;
      setDrawings((prev) => mergeUniqueDrawings(prev, drawingsRes.drawings));
      setTotalCount(drawingsRes.totalCount);
      nextOffsetRef.current += drawingsRes.drawings.length;
    } catch (err) {
      console.error("Failed to fetch more data:", err);
    } finally {
      setIsFetchingMore(false);
    }
  }, [
    isFetchingMore,
    hasMore,
    isLoading,
    debouncedSearch,
    selectedCollectionId,
    pageSize,
    sortField,
    sortDirection,
  ]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Re-fetch from the server after the OfflineContext drains pending ops, so
  // offline-created/edited drawings (which now have server ids) replace the
  // local-id placeholders in the dashboard.
  useEffect(() => {
    const onSync = () => {
      refreshData();
    };
    window.addEventListener("excalidash:offline-sync", onSync);
    return () => {
      window.removeEventListener("excalidash:offline-sync", onSync);
    };
  }, [refreshData]);

  // Re-fetch when the page becomes visible again. On iOS standalone PWAs the
  // "online" event does not fire when the app is merely backgrounded and
  // resumed (the device was never actually offline), so without this listener
  // the dashboard would show stale data until a manual refresh.
  const lastVisibilityRefreshRef = useRef(0);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefreshRef.current < 5000) return;
      lastVisibilityRefreshRef.current = now;
      refreshData();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshData]);

  return {
    drawings,
    setDrawings,
    collections,
    setCollections,
    totalCount,
    setTotalCount,
    isFetchingMore,
    isLoading,
    hasMore,
    refreshData,
    fetchMore,
  };
};
