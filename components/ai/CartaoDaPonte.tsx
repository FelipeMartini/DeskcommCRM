"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plug } from "lucide-react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * O INTERRUPTOR DA ASSINATURA DE IA DA INSTALAÇÃO (claude-ponte) — por organização.
 *
 * A instalação oferece a assinatura de IA de texto a esta organização (`CLAUDE_PONTE_*` no `.env` e a
 * organização na lista); esta tela é a escolha DELA dentro disso. O PADRÃO É LIGADA (ordem do dono,
 * 11/10/2026): o card só aparece quando a instalação oferece a ponte, e nasce com o interruptor ligado
 * sem ninguém ter marcado nada. Quem grava é `PUT /api/v1/ai/ponte` (admin); o gerente vê o estado e não
 * muda. Regra e leitura: `lib/ai/claude-ponte-ativa.ts`.
 *
 * Desligar não apaga credencial nenhuma: a chave PRÓPRIA da organização continua valendo antes da
 * assinatura. O aviso do estado desligado diz o que acontece sem ela, porque um interruptor que
 * "funciona" e deixa o agente mudo sem avisar é pior que um que não existe.
 *
 * O estado muda na tela só depois de o servidor confirmar (nada de otimismo): uma gravação que falhou
 * não pode deixar o interruptor dizendo uma coisa e o motor fazendo outra.
 */
export function CartaoDaPonte({
  ativa,
  podeEditar,
}: {
  /** O que o servidor leu em `organizations.settings.llm.ponte_ativa` (padrão: ligada). */
  ativa: boolean;
  /** Admin muda; gerente só vê. */
  podeEditar: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [ligada, setLigada] = useState(ativa);
  const [salvando, setSalvando] = useState(false);

  async function mudar(novo: boolean) {
    setSalvando(true);
    try {
      await apiClient.put("/api/v1/ai/ponte", { ativa: novo });
      setLigada(novo);
      toast.success(novo ? t("Assinatura de IA ligada.") : t("Assinatura de IA desligada."));
      // Os portões de salvar e publicar agente leem o mesmo interruptor: a página recarrega para
      // mostrar o que eles passam a dizer.
      router.refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card data-testid="cartao-da-ponte" className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Plug className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <div className="space-y-1">
            <h2 className="text-sm font-medium">{t("Assinatura de IA da instalação")}</h2>
            <p className="text-xs text-text-muted">
              {t(
                "Esta instalação oferece a assinatura de IA de texto a esta organização. Ligada, os agentes e as tarefas de IA usam a assinatura em vez de uma chave de API. Uma chave própria, se existir, continua valendo antes dela.",
              )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            data-testid="cartao-da-ponte-estado"
            className="text-xs font-medium text-text-muted"
          >
            {ligada ? t("Ligada") : t("Desligada")}
          </span>
          <Switch
            data-testid="cartao-da-ponte-interruptor"
            checked={ligada}
            disabled={!podeEditar || salvando}
            onCheckedChange={(v) => void mudar(v)}
            aria-label={t("Usar a assinatura de IA da instalação")}
          />
        </div>
      </div>
      {!ligada && (
        <p data-testid="cartao-da-ponte-aviso" className="text-xs text-warning-fg">
          {t(
            "Desligada: sem uma chave própria nem a chave da instalação, os agentes desta organização ficam sem IA até você ligar de novo.",
          )}
        </p>
      )}
      {!podeEditar && (
        <p className="text-xs text-text-muted">{t("Só administradores mudam isto.")}</p>
      )}
    </Card>
  );
}
