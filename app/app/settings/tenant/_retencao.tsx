"use client";
/**
 * O PRAZO EM QUE ESTA EMPRESA GUARDA O DADO PESSOAL DE TERCEIROS — o cartão de
 * `organizations.settings.retencao` em Configurações › Empresa (migration 0695,
 * retenção MISTA, etapa 3).
 *
 * ─── O que o cartão promete, e só isso ──────────────────────────────────────
 * A empresa só ENCURTA. O prazo da instalação continua valendo para todas (a
 * poda global roda antes) e o da empresa apaga além dele; por isso o cartão mostra
 * o prazo da instalação ao lado de cada campo e avisa "sem efeito" quando o
 * número digitado não o alcança — sem o aviso, o admin acharia que mantém o dado
 * por mais tempo, e a empresa não faz isso. Campo em branco segue a instalação.
 *
 * Quatro tipos, os que são dado pessoal de terceiros. Auditoria, fila, telemetria
 * e logs de webhook seguem iguais para todas (rastro e operação, não dado de
 * cliente), e a mídia tem o campo dela em "Dados da empresa".
 *
 * A regra mora em `lib/retencao/prazos-da-organizacao.ts` (validação, piso,
 * "sem efeito") e no SQL (o piso de verdade, que vale para qualquer chamador): a
 * tela só avisa cedo, quem recusa é o banco.
 */
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  updateRetencaoDaOrganizacao,
  type PrazosEmEdicao,
} from "@/app/actions/settings/updateRetencaoDaOrganizacao";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  PISO_DO_PRAZO_DA_ORGANIZACAO,
  PRAZO_MAXIMO_EM_DIAS,
  TIPOS_DE_PRAZO_DA_ORGANIZACAO,
  prazoSemEfeito,
  validarPrazosDaOrganizacao,
  type PrazosDaOrganizacao,
  type TipoDePrazoDaOrganizacao,
} from "@/lib/retencao/prazos-da-organizacao";

interface Props {
  /** Os prazos próprios gravados hoje, já como o banco os enxerga (elevados ao piso). */
  initial: PrazosDaOrganizacao;
  /** O prazo da instalação em vigor para cada tipo — o teto da empresa. */
  globais: Record<TipoDePrazoDaOrganizacao, number>;
}

type Texto = Record<TipoDePrazoDaOrganizacao, string>;

function comoTexto(prazos: PrazosDaOrganizacao): Texto {
  const saida = {} as Texto;
  for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
    saida[tipo] = prazos[tipo] === undefined ? "" : String(prazos[tipo]);
  }
  return saida;
}

/** "" é herdar; dígitos viram número; qualquer outra coisa segue como texto e o validador recusa. */
function comoEntrada(texto: Texto): PrazosEmEdicao {
  const entrada: Record<string, number | string | null> = {};
  for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
    const bruto = texto[tipo].trim();
    entrada[tipo] = bruto === "" ? null : /^[0-9]+$/.test(bruto) ? Number(bruto) : bruto;
  }
  return entrada as PrazosEmEdicao;
}

export function RetencaoDaOrganizacaoForm({ initial, globais }: Props) {
  const t = useT();
  const [form, setForm] = useState<Texto>(() => comoTexto(initial));
  const [salvo, setSalvo] = useState<Texto>(() => comoTexto(initial));
  const [isPending, startTransition] = useTransition();
  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);

  const campos: Array<{ tipo: TipoDePrazoDaOrganizacao; rotulo: string; ajuda: string }> = [
    {
      tipo: "captacao",
      rotulo: t("Captação de leads"),
      ajuda: t("Contatos que chegaram por formulário, anúncio ou webhook."),
    },
    {
      tipo: "conversa_do_caso",
      rotulo: t("Conversa do caso"),
      ajuda: t("Mensagens da conversa de cada caso atendido pelo agente de IA."),
    },
    {
      tipo: "prospeccao",
      rotulo: t("Prospecção"),
      ajuda: t(
        "Empresas e contatos levantados nas campanhas de prospecção. Os que estão na fila ou em envio ficam.",
      ),
    },
    {
      tipo: "espelho_da_agenda",
      rotulo: t("Espelho da agenda"),
      ajuda: t("Cópia dos eventos da agenda externa, contada a partir do fim de cada evento."),
    },
  ];

  // O que o validador recusa, por campo — o mesmo que a action repete antes do banco.
  const recusas = useMemo(() => {
    const resultado = validarPrazosDaOrganizacao(comoEntrada(form));
    const porTipo = new Map<string, string>();
    if (resultado.ok) return porTipo;
    for (const r of resultado.recusas) {
      if (r.motivo === "abaixo_do_piso") {
        porTipo.set(
          r.tipo,
          t("O mínimo é de {piso} dias.").replace("{piso}", String(r.piso ?? "")),
        );
      } else if (r.motivo === "acima_do_maximo") {
        porTipo.set(
          r.tipo,
          t("O máximo é de {max} dias.").replace("{max}", String(PRAZO_MAXIMO_EM_DIAS)),
        );
      } else {
        porTipo.set(r.tipo, t("Use um número inteiro de dias."));
      }
    }
    return porTipo;
  }, [form, t]);

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (recusas.size > 0) {
      toast.error(t("Algum prazo está fora do permitido. Confira os campos em vermelho."));
      return;
    }
    startTransition(async () => {
      const resultado = await updateRetencaoDaOrganizacao(comoEntrada(form));
      if (resultado.ok) {
        const novo = comoTexto(resultado.prazos);
        setForm(novo);
        setSalvo(novo);
        toast.success(t("Prazos de retenção salvos."));
        return;
      }
      switch (resultado.error) {
        case "validation_failed":
          toast.error(t("Algum prazo está fora do permitido. Confira os campos em vermelho."));
          return;
        case "forbidden_role":
        case "forbidden_tenant":
          toast.error(t("Só quem administra a empresa pode mudar a retenção."));
          return;
        case "mfa_required":
          toast.error(t("Confirme o segundo fator de autenticação para continuar."));
          return;
        default:
          toast.error(t("Não consegui salvar. Tente novamente."));
      }
    });
  }

  function seguirAInstalacao() {
    setForm(comoTexto({}));
  }

  return (
    <form onSubmit={salvar} className="max-w-2xl" data-testid="form-retencao">
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="text-sm font-semibold">{t("Retenção de dados pessoais")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Por quanto tempo esta empresa guarda o dado pessoal de terceiros. Cada prazo só pode encurtar o da instalação: o da instalação continua valendo para todas as empresas, e o desta apaga mais cedo. Em branco, vale o da instalação.",
            )}
          </p>
        </div>
        {campos.map(({ tipo, rotulo, ajuda }) => {
          const valor = form[tipo].trim();
          const numero = /^[0-9]+$/.test(valor) ? Number(valor) : null;
          const erro = recusas.get(tipo);
          const semEfeito = !erro && numero !== null && prazoSemEfeito(numero, globais[tipo]);
          return (
            <div key={tipo} className="space-y-2">
              <Label htmlFor={`retencao-${tipo}`}>{rotulo}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`retencao-${tipo}`}
                  data-testid={`retencao-${tipo}`}
                  type="text"
                  inputMode="numeric"
                  className="w-32"
                  value={form[tipo]}
                  placeholder={String(globais[tipo])}
                  disabled={isPending}
                  aria-invalid={erro ? true : undefined}
                  aria-describedby={`retencao-${tipo}-ajuda`}
                  onChange={(e) => setForm((f) => ({ ...f, [tipo]: e.target.value }))}
                />
                <span className="text-sm text-muted-foreground">{t("dias")}</span>
              </div>
              <p id={`retencao-${tipo}-ajuda`} className="text-xs text-muted-foreground">
                {ajuda}{" "}
                {t("Prazo da instalação: {n} dias. Mínimo: {piso} dias.")
                  .replace("{n}", String(globais[tipo]))
                  .replace("{piso}", String(PISO_DO_PRAZO_DA_ORGANIZACAO[tipo]))}
              </p>
              {erro ? (
                <p
                  className="text-xs text-destructive"
                  role="alert"
                  data-testid={`retencao-${tipo}-erro`}
                >
                  {erro}
                </p>
              ) : null}
              {semEfeito ? (
                <p className="text-xs text-amber-600" data-testid={`retencao-${tipo}-sem-efeito`}>
                  {t(
                    "Sem efeito: a instalação já apaga em {n} dias, e esta empresa só pode encurtar.",
                  ).replace("{n}", String(globais[tipo]))}
                </p>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {t(
            "Continuam iguais para todas as empresas: auditoria, fila, telemetria e registros de webhook. A mídia tem o prazo dela no campo «Retenção de mídia», acima.",
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={seguirAInstalacao}
            data-testid="retencao-seguir-instalacao"
          >
            {t("Seguir a instalação em todos")}
          </Button>
          <Button type="submit" disabled={isPending || !sujo}>
            {isPending ? t("Salvando…") : t("Salvar prazos")}
          </Button>
          {sujo ? (
            <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span>
          ) : null}
        </div>
      </Card>
    </form>
  );
}
