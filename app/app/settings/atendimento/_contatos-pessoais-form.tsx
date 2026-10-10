"use client";
/**
 * Contatos pessoais: a porta dos dois interruptores de
 * `organizations.settings.contatos_pessoais`. Sem este cartão eles só ligavam por
 * SQL. A regra mora em `lib/contacts/configuracao-pessoal.ts`; a gravação, em
 * `/api/v1/settings/contatos-pessoais`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigPessoal } from "@/lib/contacts/configuracao-pessoal";

const OPCOES = [
  {
    chave: "comando_pelo_celular" as const,
    titulo: "Marcar como pessoal digitando #pessoal no celular",
    corpo:
      "No chat do contato, no WhatsApp do número conectado, escreva só #pessoal. O contato sai da operação (sem funil, follow-up, campanha nem IA), e o comando some do chat do cliente.",
  },
  {
    chave: "novos_nascem_pessoais" as const,
    titulo: "Contato novo já nasce pessoal",
    corpo:
      "Quem aparece pela primeira vez é marcado como pessoal, a não ser que a primeira mensagem seja de uma campanha por palavra (cartão abaixo). Serve para o número que mistura vida pessoal e negócio.",
  },
];

export function ContatosPessoaisForm({ initial }: { initial: ConfigPessoal }) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [salvo, setSalvo] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const sujo =
    form.comando_pelo_celular !== salvo.comando_pelo_celular ||
    form.novos_nascem_pessoais !== salvo.novos_nascem_pessoais;

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const resposta = await apiClient.patch<{ data: ConfigPessoal }>(
          "/api/v1/settings/contatos-pessoais",
          form,
        );
        const gravado = resposta?.data ?? form;
        setForm(gravado);
        setSalvo(gravado);
        toast.success(t("Contatos pessoais salvos."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form
      onSubmit={salvar}
      className="flex max-w-3xl flex-col gap-4"
      data-testid="form-contatos-pessoais"
    >
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Contatos pessoais")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quem liga o próprio WhatsApp ao CRM entrega à operação toda conversa do aparelho. Estes dois gestos tiram da operação o que é da vida pessoal. Os dois valem para todos os números de WhatsApp desta organização e começam desligados.",
            )}
          </p>
        </div>
        {OPCOES.map((o) => (
          <label key={o.chave} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              data-testid={`pessoal-${o.chave}`}
              checked={form[o.chave]}
              disabled={isPending}
              onChange={(e) => setForm((f) => ({ ...f, [o.chave]: e.target.checked }))}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{t(o.titulo)}</span>
              <span className="block text-xs text-muted-foreground">{t(o.corpo)}</span>
            </span>
          </label>
        ))}
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo}>
          {isPending ? t("Salvando…") : t("Salvar contatos pessoais")}
        </Button>
        {sujo ? (
          <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span>
        ) : null}
      </div>
    </form>
  );
}
