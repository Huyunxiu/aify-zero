/**
 * The new-tab page of the panel.
 *
 * While it is selected, the reader picks a view to open. The page then becomes
 * that view, and it comes back once every tab is closed. Only the views in
 * `PICKABLE_VIEWS` are offered here: a view that needs a session id has no entry,
 * because the only way in is the call that started it.
 */
import { Button } from "@workspace/ui/components/button";
import { useTranslation } from "react-i18next";

import type { SessionPanelView } from "./tabs";
import { PICKABLE_VIEWS, TAB_ICONS, TAB_LABEL_KEYS } from "./views";

export type NewTabViewProps = {
  /** 打开一个视图标签。 */
  readonly onCreate: (view: SessionPanelView) => void;
};

export function NewTabView({ onCreate }: NewTabViewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {PICKABLE_VIEWS.map((view) => (
          <Button
            key={view}
            onClick={() => {
              onCreate(view);
            }}
            size="lg"
            variant="outline"
          >
            {TAB_ICONS[view]}
            {t(TAB_LABEL_KEYS[view])}
          </Button>
        ))}
      </div>
    </div>
  );
}
