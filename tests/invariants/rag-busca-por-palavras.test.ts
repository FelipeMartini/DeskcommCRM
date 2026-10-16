import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_VIEWER, countAs, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0647 — a base de conhecimento ganha a BUSCA POR PALAVRAS.
 *
 * A organização que não tem crédito de embedding (ou que só tem uma conexão de texto, como o
 * OmniRouter da instalação, que não gera vetor) passa a ter base: o material é cortado em trechos como
 * sempre, o vetor gravado é ZERO e a pergunta é respondida por `fn_buscar_trechos_por_texto`,
 * no próprio Postgres.
 *
 * O que se mede aqui, contra um Postgres real com o `baseline.sql` (o que o self-hoster recebe):
 *
 *  1. **O trecho com vetor zero entra no índice de cosseno.** É a premissa de a família existir.
 *  2. **A nota é a cobertura dos termos da pergunta**, e o que casa mais vem primeiro.
 *  3. **Acento e caixa não atrapalham** — dos dois lados.
 *  4. **O recorte é o mesmo da função vetorial**: só os materiais pedidos, ativos e prontos,
 *     só a versão ativa, só o modelo pedido; lista vazia devolve vazio (falha FECHADA).
 *  5. **O limiar corta** e pergunta só de palavra vazia não acha nada.
 *  6. **Quem não é da organização é recusado** (a função é SECURITY DEFINER), e a chave
 *     anônima não alcança nenhuma das duas funções novas.
 *
 * Cada caso vem em PAR — o que deve voltar volta E o que deve ficar de fora fica. Um teste só
 * com "0 linhas" passa com a função quebrada.
 */

const MARCADOR = "texto/postgres-fts";
const AGENTE = "eeeeeeee-1111-4000-8000-000000000647";
const VERSAO = "eeeeeeee-2222-4000-8000-000000000647";
const FONTE = "eeeeeeee-3333-4000-8000-000000000647";
const FONTE_OUTRA = "eeeeeeee-3333-4000-8000-000000000648";
const VERSAO_OUTRA = "eeeeeeee-2222-4000-8000-000000000648";
const DE_FORA = "eeeeeeee-4444-4000-8000-000000000647";

/** O vetor que o indexador grava para esta família: zero, 1536 dimensões. */
const VETOR_ZERO = `(select array_fill(0::real, array[1536])::vector)`;

function seed(): void {
  sql(`
    insert into public.ai_agents (id, organization_id, name, system_prompt, kind, is_default)
      values ('${AGENTE}', '${GOV_ORG}', 'Palavras', 'p', 'mcp_agent', false)
      on conflict do nothing;

    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE}', '${GOV_ORG}', null, 'documento', 'Perguntas e respostas (palavras)', 'ready', true),
             ('${FONTE_OUTRA}', '${GOV_ORG}', null, 'documento', 'Outro material (palavras)', 'ready', true)
      on conflict do nothing;

    insert into public.ai_knowledge_versions
      (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${VERSAO}', '${GOV_ORG}', '${AGENTE}', null, 9001, 'ready', true),
             ('${VERSAO_OUTRA}', '${GOV_ORG}', '${AGENTE}', null, 9002, 'ready', false)
      on conflict do nothing;

    update public.ai_knowledge_versions
       set embedding_model = '${MARCADOR}'
     where id in ('${VERSAO}', '${VERSAO_OUTRA}');

    update public.ai_knowledge_sources
       set active_kb_version_id = '${VERSAO}'
     where id = '${FONTE}';
    update public.ai_knowledge_sources
       set active_kb_version_id = '${VERSAO_OUTRA}'
     where id = '${FONTE_OUTRA}';

    -- O vetor é ZERO em todos: nada aqui depende de distância. Se o índice de cosseno
    -- recusasse vetor de norma zero, esta inserção falharia — é a premissa da família.
    insert into public.ai_chunks
      (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
      values
      ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 0, 'O app abre o porta-malas e trava as portas do carro.', 'p0', 12, ${VETOR_ZERO}),
      ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 1, 'A tela do ar condicionado ainda não foi distribuída no aplicativo.', 'p1', 12, ${VETOR_ZERO}),
      ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 2, 'A tela inicial mostra o saldo e o último acesso.', 'p2', 10, ${VETOR_ZERO}),
      ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 3, 'CONDIÇÃO de uso: a AÇÃO precisa de internet no celular.', 'p3', 10, ${VETOR_ZERO}),
      ('${GOV_ORG}', '${FONTE_OUTRA}', '${VERSAO_OUTRA}', 0, 'Texto de outro material sobre o ar condicionado.', 'p4', 8, ${VETOR_ZERO})
      on conflict do nothing;

    insert into auth.users (id, email)
      values ('${DE_FORA}', 'palavras-de-fora@invariant.test')
      on conflict do nothing;
  `);
}

/** Os trechos que voltam, na ordem da nota, um por linha. */
function busca(
  pergunta: string,
  fontes: string[] = [FONTE],
  limiar = 0,
  modelo: string | null = MARCADOR,
): string[] {
  const lista = fontes.map((f) => `'${f}'`).join(",");
  const m = modelo === null ? "null" : `'${modelo}'`;
  const pergunta_sql = pergunta.replace(/'/g, "''");
  const out = sql(`
    select content from public.fn_buscar_trechos_por_texto(
      '${GOV_ORG}', array[${lista}]::uuid[], '${pergunta_sql}', 10, ${limiar}::real, ${m}
    );
  `);
  return out.split("\n").filter((l) => l.trim().length > 0);
}

beforeAll(() => {
  seedGov();
  seed();
});

afterAll(() => {
  // Os outros arquivos de invariante contam linhas de GOV_ORG: não deixar o que é meu.
  try {
    sql(`
      delete from public.ai_chunks where knowledge_source_id in ('${FONTE}', '${FONTE_OUTRA}');
      delete from public.ai_knowledge_sources where id in ('${FONTE}', '${FONTE_OUTRA}');
      delete from public.ai_knowledge_versions where id in ('${VERSAO}', '${VERSAO_OUTRA}');
      delete from public.ai_agents where id = '${AGENTE}';
    `);
  } catch {
    // Limpeza é cortesia; falhar nela não pode reprovar o que foi medido.
  }
});

describe("0647 — a busca por palavras", () => {
  it("vetor zero cabe no índice de cosseno: os trechos da fixture foram gravados", () => {
    expect(
      Number(
        sql(
          `select count(*) from public.ai_chunks where knowledge_source_id in ('${FONTE}','${FONTE_OUTRA}');`,
        ),
      ),
    ).toBe(5);
  });

  it("acha o trecho pelas palavras da pergunta, e só ele", () => {
    expect(busca("porta-malas")).toEqual(["O app abre o porta-malas e trava as portas do carro."]);
  });

  it("o trecho que cobre MAIS termos da pergunta vem primeiro", () => {
    const achados = busca("tela distribuída");
    expect(achados[0]).toBe("A tela do ar condicionado ainda não foi distribuída no aplicativo.");
    // Par: o trecho que tem só "tela" também volta, atrás.
    expect(achados).toContain("A tela inicial mostra o saldo e o último acesso.");
    expect(achados.indexOf("A tela inicial mostra o saldo e o último acesso.")).toBeGreaterThan(0);
  });

  it("o limiar corta: com 0,99 só o trecho que tem a pergunta inteira", () => {
    expect(busca("tela distribuída", [FONTE], 0.99)).toEqual([
      "A tela do ar condicionado ainda não foi distribuída no aplicativo.",
    ]);
  });

  it("acento e caixa não atrapalham, dos dois lados", () => {
    // O texto tem "CONDIÇÃO" e "AÇÃO" em maiúsculas acentuadas; a pergunta vem sem acento.
    expect(busca("condicao acao")).toEqual([
      "CONDIÇÃO de uso: a AÇÃO precisa de internet no celular.",
    ]);
    // E ao contrário: texto sem acento, pergunta com.
    expect(busca("DISTRIBUÍDA")).toEqual([
      "A tela do ar condicionado ainda não foi distribuída no aplicativo.",
    ]);
  });

  it("pergunta feita só de palavra vazia não acha nada", () => {
    expect(busca("o de a e")).toEqual([]);
    expect(busca("")).toEqual([]);
  });

  it("palavra que nenhum trecho tem não acha nada (e não vira 'tudo')", () => {
    expect(busca("zzzqqq")).toEqual([]);
  });
});

describe("0647 — o recorte é o da função vetorial", () => {
  it("só os materiais pedidos: o texto do outro material não entra", () => {
    const so = busca("ar condicionado", [FONTE]);
    expect(so).toEqual(["A tela do ar condicionado ainda não foi distribuída no aplicativo."]);
  });

  it("lista de materiais vazia devolve vazio — falha FECHADA, e não 'tudo'", () => {
    expect(busca("ar condicionado", [])).toEqual([]);
  });

  it("material cuja versão ativa é OUTRA (não a deste trecho) fica de fora", () => {
    // FONTE_OUTRA aponta para VERSAO_OUTRA (ativa na fonte), mas pedir só ela com o
    // marcador certo devolve o dela; trocar o ponteiro tira o trecho.
    expect(busca("outro material", [FONTE_OUTRA])).toEqual([
      "Texto de outro material sobre o ar condicionado.",
    ]);
    sql(
      `update public.ai_knowledge_sources set active_kb_version_id = '${VERSAO}' where id = '${FONTE_OUTRA}';`,
    );
    expect(busca("outro material", [FONTE_OUTRA])).toEqual([]);
    sql(
      `update public.ai_knowledge_sources set active_kb_version_id = '${VERSAO_OUTRA}' where id = '${FONTE_OUTRA}';`,
    );
    expect(busca("outro material", [FONTE_OUTRA])).toHaveLength(1);
  });

  it("material ARQUIVADO sai da busca sem apagar trecho nenhum", () => {
    sql(
      `update public.ai_knowledge_sources set status='archived', is_active=false where id='${FONTE}';`,
    );
    expect(busca("porta-malas")).toEqual([]);
    sql(
      `update public.ai_knowledge_sources set status='ready', is_active=true where id='${FONTE}';`,
    );
    expect(busca("porta-malas")).toHaveLength(1);
  });

  it("índice calculado com OUTRO modelo fica de fora; sem modelo pedido, não filtra", () => {
    sql(
      `update public.ai_knowledge_versions set embedding_model='openai/text-embedding-3-small' where id='${VERSAO}';`,
    );
    expect(busca("porta-malas")).toEqual([]);
    expect(busca("porta-malas", [FONTE], 0, null)).toHaveLength(1);
    sql(
      `update public.ai_knowledge_versions set embedding_model='${MARCADOR}' where id='${VERSAO}';`,
    );
    expect(busca("porta-malas")).toHaveLength(1);
  });
});

describe("0647 — quem pode chamar", () => {
  it("quem é da organização, mesmo viewer, consulta", () => {
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.fn_buscar_trechos_por_texto(
           '${GOV_ORG}', array['${FONTE}']::uuid[], 'porta-malas', 10, 0::real, '${MARCADOR}'
         );`,
      ),
    ).toBe(1);
  });

  it("quem NÃO é da organização é recusado, não recebe lista vazia", () => {
    let recusou = false;
    try {
      countAs(
        DE_FORA,
        `select count(*) from public.fn_buscar_trechos_por_texto(
           '${GOV_ORG}', array['${FONTE}']::uuid[], 'porta-malas', 10, 0::real, '${MARCADOR}'
         );`,
      );
    } catch (err) {
      recusou = /caller_not_authorized_for_org/i.test(
        String((err as { stderr?: string }).stderr ?? err),
      );
    }
    expect(recusou, "um estranho consultou o acervo de outra organização").toBe(true);
  });

  it("nenhuma das duas funções novas é alcançável pela chave anônima", () => {
    // Função nova em `public` nasce exposta por DUAS origens (PUBLIC e o default ACL do anon).
    const grants = sql(`
      select coalesce(string_agg(distinct routine_name || ':' || grantee, ','), '')
        from information_schema.role_routine_grants
       where routine_schema='public'
         and routine_name in ('fn_buscar_trechos_por_texto','fn_normaliza_para_busca')
         and grantee in ('anon','PUBLIC');
    `);
    expect(grants.trim()).toBe("");
  });

  it("a normalização é imutável e tira acento sem depender de locale", () => {
    expect(sql(`select public.fn_normaliza_para_busca('AÇÃO Distribuída ÜÑ');`)).toBe(
      "acao distribuida un",
    );
    expect(
      sql(
        `select provolatile from pg_proc where proname = 'fn_normaliza_para_busca' and pronamespace = 'public'::regnamespace;`,
      ),
    ).toBe("i");
  });
});
