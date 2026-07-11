import {
  createContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useContext,
} from "react";

type Layout = "default" | "island";

type LayoutProviderProps = {
  children: React.ReactNode;
  defaultLayout?: Layout;
  storageKey?: string;
  disableTransitionOnChange?: boolean;
};

type LayoutProviderState = {
  layout: Layout;
  setLayout: (layout: Layout) => void;
};

const LayoutProviderContext = createContext<LayoutProviderState | undefined>(
  undefined
);

export function LayoutProvider({
  children,
  defaultLayout = "default",
  storageKey = "layout",
  ...props
}: LayoutProviderProps) {
  const [layout, setLayoutState] = useState<Layout>(() => {
    const storedLayout = localStorage.getItem(storageKey) as Layout | undefined;
    return storedLayout ?? defaultLayout;
  });

  const setLayout = useCallback(
    (nextLayout: Layout) => {
      localStorage.setItem(storageKey, nextLayout);
      setLayoutState(nextLayout);
    },
    [storageKey]
  );

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      const nextLayout = event.newValue as Layout | undefined;

      setLayoutState(nextLayout ?? defaultLayout);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultLayout, storageKey]);

  const value = useMemo(
    () => ({
      setLayout,
      layout,
    }),
    [layout, setLayout]
  );

  return (
    <LayoutProviderContext.Provider {...props} value={value}>
      {children}
    </LayoutProviderContext.Provider>
  );
}

export const useLayout = () => {
  const context = useContext(LayoutProviderContext);

  if (context === undefined) {
    throw new Error("useLayout must be used within a LayoutProvider");
  }

  return context;
};
