import { create } from 'zustand';
import type { Floor } from '@flashwork/shared-types';

type FloorsState = {
  floors: Floor[];
  activeFloorId: string | null;
  setFloors: (floors: Floor[]) => void;
  upsertFloor: (floor: Floor) => void;
  removeFloor: (floorId: string) => void;
  setActiveFloorId: (floorId: string | null) => void;
  getFloor: (floorId: string) => Floor | undefined;
};

export const useFloorsStore = create<FloorsState>((set, get) => ({
  floors: [],
  activeFloorId: null,
  setFloors: (floors) => set({ floors }),
  upsertFloor: (floor) => {
    const others = get().floors.filter((item) => item.id !== floor.id);
    set({
      floors: [...others, floor],
      activeFloorId: get().activeFloorId ?? floor.id,
    });
  },
  removeFloor: (floorId) => {
    const floors = get().floors.filter((item) => item.id !== floorId);
    const activeFloorId =
      get().activeFloorId === floorId ? (floors[0]?.id ?? null) : get().activeFloorId;
    set({ floors, activeFloorId });
  },
  setActiveFloorId: (floorId) => set({ activeFloorId: floorId }),
  getFloor: (floorId) => get().floors.find((floor) => floor.id === floorId),
}));
