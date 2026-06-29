import { useState } from "react";
import { Bolt, UserCog, Palette, Bot } from "lucide-react"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { Dialog, DialogContent, DialogTrigger } from "@workspace/ui/components/dialog";
import { Settings } from "../elements/settings/settings"

export function NavBottom() {
  const [open, setOpen] = useState(false);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Dialog modal={true} onOpenChange={setOpen} open={open}>
          <DialogTrigger
            render={
              <SidebarMenuButton>
                <Bolt strokeWidth={1.5} />
                <span>Setting</span>
              </SidebarMenuButton>
            }
          />
          <DialogContent
            className="h-screen max-h-none w-screen overflow-hidden rounded-none bg-sidebar p-0 sm:max-w-none"
            showCloseButton={false}
          >
            <Settings onClose={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
