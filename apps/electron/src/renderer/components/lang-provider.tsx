import * as React from "react";
import { i18n, resources } from "@workspace/shared/i18n";
import { LOCAL_STORAGE_KEYS } from "@workspace/shared/constants";

type Lang = keyof typeof resources;

type LangProviderProps = {
  children: React.ReactNode;
  defaultLang?: Lang;
  storageKey?: string;
};

type LangProviderState = {
  lang: Lang;
  langs: readonly Lang[];
  setLang: (lang: Lang) => void;
};

const LANG_VALUES = Object.keys(resources) as Lang[];

const LangProviderContext = React.createContext<LangProviderState | undefined>(undefined);

function isLang(value: string | null): value is Lang {
  if (value === null) {
    return false;
  }

  return LANG_VALUES.includes(value as Lang);
}

function applyLang(nextLang: Lang) {
  void i18n.changeLanguage(nextLang);
  document.documentElement.lang = nextLang;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const editableParent = target.closest("input, textarea, select, [contenteditable='true']");
  if (editableParent) {
    return true;
  }

  return false;
}

export function LangProvider({
  children,
  defaultLang = "en-US",
  storageKey = LOCAL_STORAGE_KEYS.LANGUAGE,
  ...props
}: LangProviderProps) {
  const [lang, setLangState] = React.useState<Lang>(() => {
    const storedLang = localStorage.getItem(storageKey);
    if (isLang(storedLang)) {
      return storedLang;
    }

    return defaultLang;
  });

  const setLang = React.useCallback(
    (nextLang: Lang) => {
      localStorage.setItem(storageKey, nextLang);
      applyLang(nextLang);
      setLangState(nextLang);
    },
    [storageKey],
  );

  React.useEffect(() => {
    applyLang(lang);
  }, [lang]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() !== "l") {
        return;
      }

      setLangState((currentLang) => {
        const currentIndex = LANG_VALUES.indexOf(currentLang);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % LANG_VALUES.length;
        const nextLang = LANG_VALUES[nextIndex];

        localStorage.setItem(storageKey, nextLang);
        return nextLang;
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [storageKey]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      if (isLang(event.newValue)) {
        setLangState(event.newValue);
        return;
      }

      setLangState(defaultLang);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultLang, storageKey]);

  const value = React.useMemo(
    () => ({
      lang,
      langs: LANG_VALUES,
      setLang,
    }),
    [lang, setLang],
  );

  return (
    <LangProviderContext.Provider {...props} value={value}>
      {children}
    </LangProviderContext.Provider>
  );
}

export const useLang = () => {
  const context = React.useContext(LangProviderContext);

  if (context === undefined) {
    throw new Error("useLang must be used within a LangProvider");
  }

  return context;
};
