import { Plug } from "lucide-react";

import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O AVISO DE QUE A IA DESTA ORGANIZAÇÃO VEM DO OMNIROUTER DA INSTALAÇÃO.
 *
 * Só informa; não tem interruptor. Quem decide se o OmniRouter atende uma organização é o
 * administrador da plataforma, no cartão da organização (Admin › Organizações › Inteligência
 * Artificial & OmniRouter), e o endereço e a chave dele são da instalação (Admin › Configuração ›
 * Credenciais). A organização só vê o resultado — e que a chave PRÓPRIA dela, se existir, vale antes.
 *
 * Aparece apenas quando `omniRouterServeAOrganizacao` (`lib/ai/omnirouter-ativo.ts`) diz que a
 * instalação atende esta organização agora; sem isso a tela não promete uma IA que o motor não acha.
 */
export function CartaoDoOmniRouter({ idioma }: { idioma?: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");
  return (
    <Card data-testid="cartao-do-omnirouter" className="space-y-1 p-4">
      <div className="flex items-start gap-2">
        <Plug className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("IA da instalação (OmniRouter)")}</h2>
          <p className="text-xs text-text-muted">
            {t(
              "Esta instalação oferece IA de texto a esta organização pelo OmniRouter. Os agentes e as tarefas de IA usam essa conexão em vez de uma chave de API. Uma chave própria, se existir, continua valendo antes dela. Só o administrador da plataforma liga ou desliga o OmniRouter para a organização.",
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}
