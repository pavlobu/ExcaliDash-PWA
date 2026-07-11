import React from "react";
import * as api from "../../api";
import { toast } from "sonner";
import type { Collection } from "../../types";
import {
  cacheCollection,
  enqueuePendingOp,
  removeCachedCollection,
  updateCachedCollection,
} from "../../db/offline-db";

type UseDashboardCollectionActionsParams = {
  selectedCollectionId: string | null | undefined;
  setSelectedCollectionId: (id: string | null | undefined) => void;
  setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
  refreshData: () => void;
};

export const useDashboardCollectionActions = ({
  selectedCollectionId,
  setSelectedCollectionId,
  setCollections,
  refreshData,
}: UseDashboardCollectionActionsParams) => {
  const handleCreateCollection = async (name: string) => {
    try {
      await api.createCollection(name);
      setCollections(await api.getCollections());
    } catch (err) {
      if (api.isNetworkError(err)) {
        const localId = crypto.randomUUID();
        const now = Date.now();
        const offlineCollection: Collection = {
          id: localId,
          name,
          createdAt: now,
          isOwner: true,
          isShared: false,
        };
        setCollections((prev) => [...prev, offlineCollection]);
        setSelectedCollectionId(localId);
        try {
          await cacheCollection(offlineCollection);
          await enqueuePendingOp({
            drawingId: localId,
            entityType: "collection",
            type: "create",
            payload: { name },
          });
          toast.info("Offline: collection created locally. Will sync when reconnected.");
        } catch (cacheErr) {
          console.error("Failed to cache offline collection:", cacheErr);
        }
        return;
      }
      console.error("Failed to create collection:", err);
      refreshData();
    }
  };

  const handleEditCollection = async (id: string, name: string) => {
    setCollections((current) =>
      current.map((collection) =>
        collection.id === id ? { ...collection, name } : collection,
      ),
    );
    try {
      await api.updateCollection(id, name);
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await updateCachedCollection(id, { name });
          await enqueuePendingOp({
            drawingId: id,
            entityType: "collection",
            type: "update",
            payload: { name },
          });
          toast.info("Offline: collection rename saved locally. Will sync when reconnected.");
        } catch (cacheErr) {
          console.error("Failed to cache offline collection rename:", cacheErr);
        }
        return;
      }
      console.error("Failed to rename collection:", err);
      refreshData();
    }
  };

  const handleDeleteCollection = async (id: string) => {
    setCollections((current) =>
      current.filter((collection) => collection.id !== id),
    );
    if (selectedCollectionId === id) setSelectedCollectionId(undefined);
    try {
      await api.deleteCollection(id);
      refreshData();
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await enqueuePendingOp({
            drawingId: id,
            entityType: "collection",
            type: "delete",
            payload: null,
          });
          await removeCachedCollection(id);
          toast.info("Offline: collection deletion saved locally. Will sync when reconnected.");
        } catch (cacheErr) {
          console.error("Failed to cache offline collection deletion:", cacheErr);
        }
        return;
      }
      console.error("Failed to delete collection:", err);
      refreshData();
    }
  };

  return {
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,
  };
};
