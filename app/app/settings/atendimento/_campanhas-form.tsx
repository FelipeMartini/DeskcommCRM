"use client";
/**
 * Campanhas por palavra: o editor de `organizations.settings.campanhas_whatsapp`,
 * a dívida que o `user-journey-map` (J20) declarava. Sem este cartão a lista só se
 * escrevia por SQL. O formato e o piso da frase moram em
 * `lib/ai/elegibilidade/campanha-gravacao.ts`; a gravação, em
 * `/api/v1/settings/campanhas-whatsapp` (admin).
 *
 * A lista é enviada INTEIRA e a ordem importa (a primeira que casa vence). Os campos
 * que a tela não edita (`agent_id`, `segmento`) voltam como vieram.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import {
  CAMPANHA_MATCH_TIPOS,
  normalizarParaMatch,
  type CampanhaWhatsapp,
} from "@/lib/ai/elegibilidade/campanha";
import { MAX_CAMPANHAS, MIN_FRASE_NORMALIZADA } from "@/lib/ai/elegibilidade/campanha-gravacao";
import { randomId } from "@/lib/random-id";

export interface CanalDaCampanha {
  id: string;
  nome: string;
}

/** Abaixo disto a frase é "curta": casa conversa comum, e casar autoriza a IA. */
const FRASE_CURTA = 12;

const TIPOS: Record<(typeof CAMPANHA_MATCH_TIPOS)[number], string> = {
  contains: "Contém a frase",
  starts_with: "Começa com a frase",
};

function novaCampanha(): CampanhaWhatsapp {
  return { id: `camp-${randomId().slice(0, 8)}`, match: { tipo: "contains", valor: "" } };
}

/** O que vai ao servidor: rótulo em branco sai, a frase perde as pontas. */
function limpar(c: CampanhaWhatsapp): CampanhaWhatsapp {
  const rotulo = c.label?.trim();
  const { label: _antigo, ...resto } = c;
  void _antigo;
  return {
    ...resto,
    ...(rotulo ? { label: rotulo } : {}),
    match: { ...c.match, valor: c.match.valor.trim() },
  };
}

/**
 * A lista numa forma comparável: ordem de campos fixa, para que "o que veio do
 * servidor" e "o que a pessoa editou" só difiram quando o CONTEÚDO difere.
 */
function assinatura(lista: CampanhaWhatsapp[]): string {
  return JSON.stringify(
    lista.map((c) => [
      c.id,
      c.label?.trim() || null,
      c.match.tipo,
      c.match.valor.trim(),
      c.agent_id ?? null,
      c.segmento ?? null,
      c.channel_session_id ?? null,
    ]),
  );
}

export function CampanhasPorPalavraForm({
  initial,
  canais,
  descartadas,
  podeEditar,
}: {
  initial: CampanhaWhatsapp[];
  canais: CanalDaCampanha[];
  descartadas: number;
  podeEditar: boolean;
}) {
  const t = useT();
  const [lista, setLista] = useState(initial);
  const [salva, setSalva] = useState(initial);
  // Itens malformados do jsonb que o motor ignora: salvar os remove, e depois de
  // salvar não há mais o que limpar (a página só relê no próximo carregamento).
  const [aLimpar, setALimpar] = useState(descartadas);
  const [isPending, startTransition] = useTransition();
  const bloqueado = isPending || !podeEditar;

  const invalida = (c: CampanhaWhatsapp) =>
    normalizarParaMatch(c.match.valor).length < MIN_FRASE_NORMALIZADA;
  const algumaInvalida = lista.some(invalida);
  const sujo = aLimpar > 0 || assinatura(lista) !== assinatura(salva);

  function mudar(id: string, parte: (c: CampanhaWhatsapp) => CampanhaWhatsapp) {
    setLista((atual) => atual.map((c) => (c.id === id ? parte(c) : c)));
  }

  function mover(indice: number, delta: -1 | 1) {
    setLista((atual) => {
      const destino = indice + delta;
      if (destino < 0 || destino >= atual.length) return atual;
      const copia = [...atual];
      [copia[indice], copia[destino]] = [copia[destino]!, copia[indice]!];
      return copia;
    });
  }

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const limpa = lista.map(limpar);
        const resposta = await apiClient.put<{ data: { campanhas: CampanhaWhatsapp[] } }>(
          "/api/v1/settings/campanhas-whatsapp",
          { campanhas: limpa },
        );
        const gravada = resposta?.data?.campanhas ?? limpa;
        setLista(gravada);
        setSalva(gravada);
        setALimpar(0);
        toast.success(t("Campanhas salvas."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form
      onSubmit={salvar}
      className="flex max-w-3xl flex-col gap-4"
      data-testid="form-campanhas-palavra"
    >
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Campanhas por palavra")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Cadastre a frase que o anúncio ou o link coloca na primeira mensagem do cliente. Se a mensagem contém a frase, a IA pode assumir a conversa nos números em «IA restrita por origem», e, com «Contato novo já nasce pessoal» ligado, quem chega por uma campanha não vira pessoal. Maiúsculas, acentos e espaços repetidos não contam, e vale a primeira campanha da lista que casar.",
            )}
          </p>
          {!podeEditar ? (
            <p className="mt-2 text-xs font-medium" data-testid="campanhas-so-leitura">
              {t("Só administradores editam as campanhas por palavra.")}
            </p>
          ) : null}
          {aLimpar > 0 ? (
            <p className="mt-2 text-xs font-medium" data-testid="campanhas-descartadas">
              {t(
                "Há itens na configuração que o sistema ignora por estarem incompletos. Salvar remove esses itens.",
              )}
            </p>
          ) : null}
        </div>

        {lista.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="campanhas-vazio">
            {t("Nenhuma campanha cadastrada.")}
          </p>
        ) : null}

        <ol className="space-y-4">
          {lista.map((c, indice) => {
            const campo = (nome: string) => `campanha-${c.id}-${nome}`;
            const normalizada = normalizarParaMatch(c.match.valor);
            return (
              <li
                key={c.id}
                className="space-y-3 rounded-lg border p-3"
                data-testid={`campanha-${c.id}`}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={campo("nome")}>{t("Nome da campanha")}</Label>
                    <Input
                      id={campo("nome")}
                      value={c.label ?? ""}
                      maxLength={120}
                      disabled={bloqueado}
                      onChange={(e) => mudar(c.id, (x) => ({ ...x, label: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("Só para você reconhecer na lista.")}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={campo("tipo")}>{t("A mensagem")}</Label>
                    <select
                      id={campo("tipo")}
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={c.match.tipo}
                      disabled={bloqueado}
                      onChange={(e) =>
                        mudar(c.id, (x) => ({
                          ...x,
                          match: {
                            ...x.match,
                            tipo: e.target.value as CampanhaWhatsapp["match"]["tipo"],
                          },
                        }))
                      }
                    >
                      {CAMPANHA_MATCH_TIPOS.map((tipo) => (
                        <option key={tipo} value={tipo}>
                          {t(TIPOS[tipo])}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor={campo("frase")}>{t("Frase da campanha")}</Label>
                  <Input
                    id={campo("frase")}
                    value={c.match.valor}
                    maxLength={400}
                    disabled={bloqueado}
                    aria-invalid={invalida(c)}
                    onChange={(e) =>
                      mudar(c.id, (x) => ({ ...x, match: { ...x.match, valor: e.target.value } }))
                    }
                  />
                  {invalida(c) ? (
                    <p className="text-xs font-medium text-destructive" data-testid={campo("erro")}>
                      {t(
                        "A frase precisa ter pelo menos 3 caracteres, sem contar espaços repetidos.",
                      )}
                    </p>
                  ) : normalizada.length < FRASE_CURTA ? (
                    <p className="text-xs text-muted-foreground" data-testid={campo("aviso")}>
                      {t(
                        "Frase curta: qualquer mensagem que a contenha autoriza a IA. Prefira uma frase específica da campanha.",
                      )}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1 sm:max-w-sm">
                  <Label htmlFor={campo("canal")}>{t("Vale em")}</Label>
                  <select
                    id={campo("canal")}
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    value={c.channel_session_id ?? ""}
                    disabled={bloqueado}
                    onChange={(e) =>
                      mudar(c.id, (x) => {
                        const { channel_session_id: _antigo, ...resto } = x;
                        void _antigo;
                        return e.target.value
                          ? { ...resto, channel_session_id: e.target.value }
                          : resto;
                      })
                    }
                  >
                    <option value="">{t("Todos os números")}</option>
                    {canais.map((canal) => (
                      <option key={canal.id} value={canal.id}>
                        {canal.nome}
                      </option>
                    ))}
                  </select>
                </div>

                {podeEditar ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={bloqueado || indice === 0}
                      onClick={() => mover(indice, -1)}
                    >
                      {t("Subir")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={bloqueado || indice === lista.length - 1}
                      onClick={() => mover(indice, 1)}
                    >
                      {t("Descer")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={bloqueado}
                      onClick={() => setLista((atual) => atual.filter((x) => x.id !== c.id))}
                    >
                      {t("Remover")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>

        {podeEditar ? (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={bloqueado || lista.length >= MAX_CAMPANHAS}
              onClick={() => setLista((atual) => [...atual, novaCampanha()])}
            >
              {t("Adicionar campanha")}
            </Button>
            {lista.length >= MAX_CAMPANHAS ? (
              <span className="ml-3 text-xs text-muted-foreground">
                {t("Limite de campanhas atingido.")}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {podeEditar ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !sujo || algumaInvalida}>
            {isPending ? t("Salvando…") : t("Salvar campanhas")}
          </Button>
          {sujo ? (
            <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
