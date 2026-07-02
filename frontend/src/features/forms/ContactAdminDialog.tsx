import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/t";

/**
 * Public "Contact the organisers" dialog: anyone on a registration form can send
 * a message that emails the tournament admins (sender set as reply-to). Inline
 * success/error — no toast dependency on the public shell.
 */
export function ContactAdminDialog({
  formId,
  open,
  onOpenChange,
}: {
  formId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const send = useMutation({
    mutationFn: () =>
      formsApi.contactAdmin(formId, {
        name: name.trim(),
        email: email.trim(),
        message: message.trim(),
      }),
    onSuccess: () => setSent(true),
  });

  const close = (o: boolean): void => {
    onOpenChange(o);
    if (!o) {
      setSent(false);
      setName("");
      setEmail("");
      setMessage("");
      send.reset();
    }
  };

  const valid =
    name.trim() !== "" && email.trim() !== "" && message.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={close} ariaLabel={t("Contact the organisers")}>
      <DialogHeader>
        <DialogTitle>{t("Contact the organisers")}</DialogTitle>
        <DialogDescription>
          {t("Send the organisers a message.")}
        </DialogDescription>
      </DialogHeader>

      {sent ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 aria-hidden="true" className="h-8 w-8 text-primary" />
          <p className="text-sm font-medium">{t("Message sent")}</p>
          <p className="text-sm text-muted-foreground">
            {t("The organisers will reply to you by email.")}
          </p>
          <Button className="mt-2" onClick={() => close(false)}>
            {t("Done")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-name">{t("Your name")}</Label>
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-email">{t("Your email")}</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-message">{t("Message")}</Label>
              <textarea
                id="contact-message"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
            {send.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {send.error instanceof ApiError
                  ? (send.error.payload.detail ?? t("Couldn't send · please try again."))
                  : t("Couldn't send · please try again.")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => send.mutate()} disabled={!valid || send.isPending}>
              {send.isPending ? t("Sending…") : t("Send message")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
