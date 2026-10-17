import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * O PRAZO DE RETENÇÃO POR ORGANIZAÇÃO CONTRA UM POSTGRES DE VERDADE — migration 0695.
 *
 * ─── O que esta suíte garante que o teste de unidade não garante ──────────
 *
 * Os testes de unidade (`retencao-por-organizacao*.test.ts`) leem o texto do SQL
 * e simulam o banco. Aqui o `baseline.sql` que o kit self-host aplica roda de
 * verdade, e as cinco funções são chamadas como o cron e a Server Action as
 * chamam. Os pontos que só o banco prova:
 *
 * 1. A organização SÓ ENCURTA: sem prazo próprio, a passada por organização não
 *    toca em nada (quem cuida é a poda global); o valor abaixo do piso é elevado
 *    ao piso DENTRO do corpo, então um `psql` na mão não vira apagador de rastro
 *    recente; texto, negativo, decimal e número de 7 dígitos no `settings` são
 *    ignorados em vez de derrubar a passada.
 * 2. A poda de UMA organização não encosta nas outras (o dado é pessoal de
 *    terceiros — alcançar a organização errada é o pior erro possível aqui).
 * 3. A prospecção mantém as três guardas da poda global: fila, envio em
 *    andamento e o tombstone de supressão (0370) nunca saem.
 * 4. A gravação só aceita admin ATIVO da própria organização (ou admin da
 *    plataforma), recusa chave de tipo global, valor abaixo do piso e tipo
 *    torto, e a recusa não altera nada; as outras chaves de `settings` ficam.
 * 5. Nenhuma das cinco funções fica ao alcance de anon, authenticated ou PUBLIC.
 */

const ORG_A = "26880000-0000-4000-8000-00000000000a"; // todos os quatro prazos próprios
const ORG_B = "26880000-0000-4000-8000-00000000000b"; // sem prazo próprio
const ORG_C = "26880000-0000-4000-8000-00000000000c"; // settings torto
const ORG_D = "26880000-0000-4000-8000-00000000000d"; // abaixo do piso
const ORGS = [ORG_A, ORG_B, ORG_C, ORG_D];
const ORGS_SQL = ORGS.map((o) => `'${o}'`).join(", ");

const ADMIN_B = "26880000-1111-4000-8000-000000000001";
const AGENTE_B = "26880000-1111-4000-8000-000000000002";
const ADMIN_B_REVOGADO = "26880000-1111-4000-8000-000000000003";
const ADMIN_DA_PLATAFORMA = "26880000-1111-4000-8000-000000000009";

const CAMPANHA = "26880000-2222-4000-8000-000000000001";

const FUNCOES = [
  "public.fn_piso_de_retencao_por_organizacao(text)",
  "public.fn_prazo_de_retencao_da_organizacao(uuid,text)",
  "public.fn_organizacoes_com_prazo_proprio()",
  "public.fn_expurgar_por_organizacao(text,uuid,int)",
  "public.fn_definir_retencao_da_organizacao(uuid,uuid,jsonb)",
];

function conta(query: string): number {
  return Number(lastLine(sql(query)));
}

function texto(query: string): string {
  return lastLine(sql(query));
}

/**
 * Roda o SQL e devolve o MOTIVO NOMEADO do erro ("" se não levantou). O psql não
 * imprime o SQLSTATE; os erros desta migration trazem o motivo na mensagem
 * (`retencao_da_organizacao_*` na gravação, `retencao_por_organizacao_*` na poda e
 * no prazo). Erro sem motivo nomeado devolve a saída inteira, e o teste que
 * espera um motivo específico reprova.
 */
function estadoDoErro(query: string): string {
  try {
    sql(query);
    return "";
  } catch (e) {
    const saida = String((e as { stderr?: unknown }).stderr ?? e);
    const m = saida.match(/retencao_(?:da|por)_organizacao_[a-z_]+/);
    return m ? m[0] : saida;
  }
}

/** As linhas de teste entram sem as FKs (só o que o teste precisa existe). */
const SEM_FK = "set session_replication_role = replica;";

beforeEach(() => {
  sql(`
    ${SEM_FK}
    delete from webhook_lead_captures where organization_id in (${ORGS_SQL});
    delete from agent_case_chat_messages where organization_id in (${ORGS_SQL});
    delete from prospecting_candidates where organization_id in (${ORGS_SQL});
    delete from calendar_external_events where organization_id in (${ORGS_SQL});
    delete from user_organizations where organization_id in (${ORGS_SQL});
    delete from platform_admins where user_id = '${ADMIN_DA_PLATAFORMA}';
    insert into organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'ret-org-a', 'A', 'A',
       '{"retencao":{"captacao_dias":40,"conversa_do_caso_dias":100,"prospeccao_dias":95,"espelho_da_agenda_dias":10},"branding":{"app_name":"Marca A"}}'),
      ('${ORG_B}', 'ret-org-b', 'B', 'B', '{}'),
      ('${ORG_C}', 'ret-org-c', 'C', 'C',
       '{"retencao":{"captacao_dias":"abc","conversa_do_caso_dias":-5,"prospeccao_dias":90.5,"espelho_da_agenda_dias":1000000}}'),
      ('${ORG_D}', 'ret-org-d', 'D', 'D',
       '{"retencao":{"captacao_dias":5,"espelho_da_agenda_dias":0}}')
    on conflict (id) do update set settings = excluded.settings;
    insert into user_organizations (user_id, organization_id, role) values
      ('${ADMIN_B}', '${ORG_B}', 'admin'),
      ('${AGENTE_B}', '${ORG_B}', 'agent');
    insert into user_organizations (user_id, organization_id, role, revoked_at) values
      ('${ADMIN_B_REVOGADO}', '${ORG_B}', 'admin', now());
    insert into platform_admins (user_id, granted_by, reason)
      values ('${ADMIN_DA_PLATAFORMA}', '${ADMIN_DA_PLATAFORMA}', 'teste do invariante 0695');
  `);
});

function semearCaptacao(org: string, idadesEmDias: number[]): void {
  sql(`
    ${SEM_FK}
    insert into webhook_lead_captures (organization_id, source_name, outcome, received_at)
    select '${org}', 'fonte', 'criado', now() - make_interval(days => d)
      from unnest(array[${idadesEmDias.join(",")}]::int[]) d;
  `);
}

describe("o piso e o prazo efetivo da organização", () => {
  it("cada tipo tem o piso que a política manda; tipo global não tem piso por organização", () => {
    expect(texto("select public.fn_piso_de_retencao_por_organizacao('captacao')")).toBe("30");
    expect(texto("select public.fn_piso_de_retencao_por_organizacao('conversa_do_caso')")).toBe(
      "90",
    );
    expect(texto("select public.fn_piso_de_retencao_por_organizacao('prospeccao')")).toBe("90");
    expect(texto("select public.fn_piso_de_retencao_por_organizacao('espelho_da_agenda')")).toBe(
      "7",
    );
    expect(
      texto(
        "select coalesce(public.fn_piso_de_retencao_por_organizacao('auditoria')::text, 'nulo')",
      ),
    ).toBe("nulo");
  });

  it("prazo próprio vale; sem prazo é nulo; valor torto no settings é ignorado", () => {
    const prazo = (org: string, tipo: string) =>
      texto(
        `select coalesce(public.fn_prazo_de_retencao_da_organizacao('${org}', '${tipo}')::text, 'nulo')`,
      );
    expect(prazo(ORG_A, "captacao")).toBe("40");
    expect(prazo(ORG_A, "conversa_do_caso")).toBe("100");
    expect(prazo(ORG_B, "captacao")).toBe("nulo");
    for (const tipo of ["captacao", "conversa_do_caso", "prospeccao", "espelho_da_agenda"]) {
      expect(
        prazo(ORG_C, tipo),
        `C/${tipo}: texto, negativo, decimal e 7 dígitos são ignorados`,
      ).toBe("nulo");
    }
  });

  it("abaixo do piso é ELEVADO ao piso dentro do corpo (5 → 30, 0 → 7)", () => {
    expect(texto(`select public.fn_prazo_de_retencao_da_organizacao('${ORG_D}', 'captacao')`)).toBe(
      "30",
    );
    expect(
      texto(`select public.fn_prazo_de_retencao_da_organizacao('${ORG_D}', 'espelho_da_agenda')`),
    ).toBe("7");
  });

  it("organização inexistente é nulo; tipo desconhecido levanta", () => {
    expect(
      texto(
        "select coalesce(public.fn_prazo_de_retencao_da_organizacao('26880000-0000-4000-8000-0000000000ff', 'captacao')::text, 'nulo')",
      ),
    ).toBe("nulo");
    expect(
      estadoDoErro(`select public.fn_prazo_de_retencao_da_organizacao('${ORG_A}', 'auditoria')`),
    ).toBe("retencao_por_organizacao_tipo_desconhecido");
  });

  it("a lista traz os pares (organização, tipo) com prazo — e nenhum de B nem de C", () => {
    const linhas = (filtro: string) =>
      conta(`select count(*) from public.fn_organizacoes_com_prazo_proprio() where ${filtro}`);
    expect(linhas(`organization_id = '${ORG_A}'`)).toBe(4);
    expect(linhas(`organization_id = '${ORG_D}'`)).toBe(2);
    expect(linhas(`organization_id = '${ORG_B}'`)).toBe(0);
    expect(linhas(`organization_id = '${ORG_C}'`)).toBe(0);
    // e o prazo da lista já vem com o piso aplicado
    expect(
      texto(
        `select dias from public.fn_organizacoes_com_prazo_proprio() where organization_id = '${ORG_D}' and tipo = 'captacao'`,
      ),
    ).toBe("30");
  });
});

describe("fn_expurgar_por_organizacao — só a organização que escolheu, só além do prazo", () => {
  it("captação: sem prazo próprio apaga 0; com prazo apaga só o vencido; o limite corta o lote", () => {
    semearCaptacao(ORG_A, [10, 35, 41, 200]);
    semearCaptacao(ORG_B, [200]);
    semearCaptacao(ORG_D, [20, 31]);

    expect(conta(`select public.fn_expurgar_por_organizacao('captacao', '${ORG_B}')`)).toBe(0);
    expect(
      conta(`select count(*) from webhook_lead_captures where organization_id = '${ORG_B}'`),
    ).toBe(1);

    expect(conta(`select public.fn_expurgar_por_organizacao('captacao', '${ORG_A}', 1)`)).toBe(1);
    expect(conta(`select public.fn_expurgar_por_organizacao('captacao', '${ORG_A}')`)).toBe(1);
    expect(
      conta(`select count(*) from webhook_lead_captures where organization_id = '${ORG_A}'`),
    ).toBe(2);
    expect(conta(`select public.fn_expurgar_por_organizacao('captacao', '${ORG_A}')`)).toBe(0);

    // D pediu 5 dias e ganhou o piso de 30: a de 31 sai, a de 20 fica
    expect(conta(`select public.fn_expurgar_por_organizacao('captacao', '${ORG_D}')`)).toBe(1);
    expect(
      conta(`select count(*) from webhook_lead_captures where organization_id = '${ORG_D}'`),
    ).toBe(1);
  });

  it("conversa do caso: apaga além do prazo da organização e não toca nas outras", () => {
    sql(`
      ${SEM_FK}
      insert into agent_case_chat_messages
        (organization_id, case_id, conversation_id, contact_id, turn_id, author_kind, created_at)
      select o, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ai',
             now() - make_interval(days => d)
        from (values ('${ORG_A}'::uuid, 99), ('${ORG_A}', 101), ('${ORG_B}', 400)) s(o, d);
    `);
    expect(conta(`select public.fn_expurgar_por_organizacao('conversa_do_caso', '${ORG_A}')`)).toBe(
      1,
    );
    expect(
      conta(`select count(*) from agent_case_chat_messages where organization_id = '${ORG_A}'`),
    ).toBe(1);
    expect(
      conta(`select count(*) from agent_case_chat_messages where organization_id = '${ORG_B}'`),
    ).toBe(1);
  });

  it("prospecção: fila, envio em andamento, tombstone e tentativa recente FICAM", () => {
    sql(`
      ${SEM_FK}
      insert into prospecting_candidates
        (organization_id, campaign_id, place_id, data, status, attempted_at, created_at, suppression_salt)
      select '${ORG_A}', '${CAMPANHA}', p, '{}'::jsonb, st,
             case when att is null then null else now() - make_interval(days => att) end,
             now() - make_interval(days => cr), salt
        from (values
          ('p-vencido',   'new',     null::int, 200, null::bytea),
          ('p-fila',      'queued',  null,      200, null),
          ('p-enviando',  'sending', null,      200, null),
          ('p-tombstone', 'failed',  null,      200, '\\x00'::bytea),
          ('p-tentado',   'sent',    10,        200, null),
          ('p-recente',   'new',     null,      10,  null)) s(p, st, att, cr, salt);
      insert into prospecting_candidates
        (organization_id, campaign_id, place_id, data, status, created_at)
      values ('${ORG_B}', '${CAMPANHA}', 'b-velho', '{}'::jsonb, 'new', now() - interval '400 days');
    `);
    expect(conta(`select public.fn_expurgar_por_organizacao('prospeccao', '${ORG_A}')`)).toBe(1);
    expect(
      texto(
        `select string_agg(place_id, ',' order by place_id) from prospecting_candidates where organization_id = '${ORG_A}'`,
      ),
    ).toBe("p-enviando,p-fila,p-recente,p-tentado,p-tombstone");
    expect(
      conta(`select count(*) from prospecting_candidates where organization_id = '${ORG_B}'`),
    ).toBe(1);
  });

  it("espelho da agenda: conta do FIM do evento, só na organização com prazo", () => {
    sql(`
      ${SEM_FK}
      insert into calendar_external_events
        (organization_id, connection_id, external_calendar_id, external_event_id, starts_at, ends_at)
      select o, gen_random_uuid(), 'cal', 'ev-' || d || '-' || substr(o::text, 12, 2),
             now() - make_interval(days => d + 1), now() - make_interval(days => d)
        from (values ('${ORG_A}'::uuid, 5), ('${ORG_A}', 12), ('${ORG_B}', 200)) s(o, d);
    `);
    expect(
      conta(`select public.fn_expurgar_por_organizacao('espelho_da_agenda', '${ORG_A}')`),
    ).toBe(1);
    expect(
      conta(`select count(*) from calendar_external_events where organization_id = '${ORG_A}'`),
    ).toBe(1);
    expect(
      conta(`select count(*) from calendar_external_events where organization_id = '${ORG_B}'`),
    ).toBe(1);
  });

  it("tipo global ou organização nula levanta em vez de apagar", () => {
    expect(estadoDoErro(`select public.fn_expurgar_por_organizacao('auditoria', '${ORG_A}')`)).toBe(
      "retencao_por_organizacao_tipo_desconhecido",
    );
    expect(estadoDoErro("select public.fn_expurgar_por_organizacao('captacao', null)")).toBe(
      "retencao_por_organizacao_sem_organizacao",
    );
  });
});

describe("fn_definir_retencao_da_organizacao — quem grava e o que se aceita", () => {
  const grava = (org: string, quem: string, prazos: string) =>
    `select public.fn_definir_retencao_da_organizacao('${org}', '${quem}', '${prazos}'::jsonb)`;
  const retencao = (org: string) =>
    texto(
      `select coalesce((settings -> 'retencao')::text, 'ausente') from organizations where id = '${org}'`,
    );

  it("recusa agente comum, admin revogado e admin de outra organização — sem alterar nada", () => {
    for (const quem of [AGENTE_B, ADMIN_B_REVOGADO]) {
      expect(estadoDoErro(grava(ORG_B, quem, '{"captacao_dias":60}'))).toBe(
        "retencao_da_organizacao_sem_permissao",
      );
    }
    expect(estadoDoErro(grava(ORG_A, ADMIN_B, '{"captacao_dias":60}'))).toBe(
      "retencao_da_organizacao_sem_permissao",
    );
    expect(retencao(ORG_B)).toBe("ausente");
    expect(retencao(ORG_A)).toContain('"captacao_dias": 40');
  });

  it("admin da organização grava; null herda; o resultado vale na hora para o prazo efetivo", () => {
    expect(
      conta(
        grava(
          ORG_B,
          ADMIN_B,
          '{"captacao_dias":60,"prospeccao_dias":120,"espelho_da_agenda_dias":null}',
        ),
      ),
    ).toBe(1);
    expect(retencao(ORG_B)).toBe('{"captacao_dias": 60, "prospeccao_dias": 120}');
    expect(texto(`select public.fn_prazo_de_retencao_da_organizacao('${ORG_B}', 'captacao')`)).toBe(
      "60",
    );
  });

  it("admin da plataforma grava em qualquer uma, substitui o estado anterior e não toca nas outras chaves", () => {
    expect(conta(grava(ORG_A, ADMIN_DA_PLATAFORMA, '{"conversa_do_caso_dias":150}'))).toBe(1);
    expect(retencao(ORG_A)).toBe('{"conversa_do_caso_dias": 150}');
    expect(
      texto(
        `select settings -> 'branding' ->> 'app_name' from organizations where id = '${ORG_A}'`,
      ),
    ).toBe("Marca A");
  });

  it.each([
    ['{"auditoria_dias":60}', "tipo global", "retencao_da_organizacao_chave_desconhecida"],
    ['{"captacao":60}', "chave sem o sufixo _dias", "retencao_da_organizacao_chave_desconhecida"],
    ['{"captacao_dias":10}', "abaixo do piso", "retencao_da_organizacao_abaixo_do_piso"],
    ['{"captacao_dias":60.5}', "decimal", "retencao_da_organizacao_valor_invalido"],
    ['{"captacao_dias":"60"}', "texto", "retencao_da_organizacao_valor_invalido"],
    ['{"captacao_dias":1000000}', "7 dígitos", "retencao_da_organizacao_valor_invalido"],
    ["[1,2]", "array", "retencao_da_organizacao_forma_invalida"],
  ])("recusa %s (%s) e deixa o settings como estava", (prazos, _motivo, erro) => {
    const antes = retencao(ORG_D);
    expect(estadoDoErro(grava(ORG_D, ADMIN_DA_PLATAFORMA, prazos))).toBe(erro);
    expect(retencao(ORG_D)).toBe(antes);
  });

  it("objeto vazio e null removem a chave `retencao`; organização inexistente devolve 0", () => {
    expect(conta(grava(ORG_B, ADMIN_B, '{"captacao_dias":60}'))).toBe(1);
    expect(conta(grava(ORG_B, ADMIN_B, "{}"))).toBe(1);
    expect(retencao(ORG_B)).toBe("ausente");
    expect(
      conta(
        `select public.fn_definir_retencao_da_organizacao('${ORG_A}', '${ADMIN_DA_PLATAFORMA}', null)`,
      ),
    ).toBe(1);
    expect(retencao(ORG_A)).toBe("ausente");
    expect(
      conta(
        `select public.fn_definir_retencao_da_organizacao('26880000-0000-4000-8000-0000000000ff', '${ADMIN_DA_PLATAFORMA}', '{"captacao_dias":60}'::jsonb)`,
      ),
    ).toBe(0);
  });
});

describe("os privilégios das cinco funções, medidos", () => {
  it.each(FUNCOES)("%s: PUBLIC, anon e authenticated SEM execute; service_role COM", (funcao) => {
    for (const papel of ["public", "anon", "authenticated"]) {
      expect(
        texto(`select has_function_privilege('${papel}', '${funcao}', 'EXECUTE')`),
        `papel ${papel} não deveria ter EXECUTE em ${funcao}`,
      ).toBe("f");
    }
    expect(texto(`select has_function_privilege('service_role', '${funcao}', 'EXECUTE')`)).toBe(
      "t",
    );
  });
});
