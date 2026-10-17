-- manifest: Retenção de dado pessoal POR ORGANIZAÇÃO (modelo MISTO, etapas 2 e 3): captação de lead, conversa do caso, prospecção e espelho da agenda ganham um prazo próprio em `organizations.settings.retencao` que só ENCURTA o prazo global (nunca passa dele, nunca fica abaixo do piso fixo, que mora no corpo das funções). Cria `fn_piso_de_retencao_por_organizacao`, `fn_prazo_de_retencao_da_organizacao`, `fn_organizacoes_com_prazo_proprio`, `fn_expurgar_por_organizacao` (poda em lotes, uma organização e um tipo por chamada) e `fn_definir_retencao_da_organizacao` (gravação atômica, só admin da organização ou da plataforma). As podas globais existentes ficam intactas.
-- ═══════════════════════════════════════════════════════════════════════════
-- 0688 — o prazo de retenção do dado pessoal passa a poder ser da ORGANIZAÇÃO.
--
-- ─── Por que ───────────────────────────────────────────────────────────────
-- Hoje o prazo de cada tipo de dado é um só para a INSTALAÇÃO inteira (16
-- variáveis `*_RETENTION_DAYS`, hoje editáveis no painel — etapa 1, PR #25).
-- Para dado de TERCEIROS que a empresa colheu (o lead que preencheu um
-- formulário, a pessoa que a prospecção achou, a conversa do caso, o espelho da
-- agenda), a controladora é a EMPRESA, e o prazo certo depende do setor dela.
-- A instalação é a operadora: responde pelo TETO, não pelo prazo de cada uma.
--
-- ─── O que fica de fora, de propósito ──────────────────────────────────────
-- Auditoria, fila, telemetria de IA, logs de webhook, passagem e afins seguem
-- GLOBAIS: são rastro e operação da instalação. Prazo por organização na
-- auditoria deixaria uma empresa apagar o próprio rastro. A mídia já é por
-- organização (`media_retention_days`) e não muda.
--
-- ─── "Só encurta" sem a função saber o teto ────────────────────────────────
-- A função NÃO conhece o prazo global (ele vem do painel/`.env`, lido pelo
-- TypeScript), e não precisa: a poda global continua rodando para TODAS as
-- organizações com o prazo global, e esta apaga ALÉM dela o que for mais velho
-- que o prazo da organização. O que sobra é o menor dos dois — um prazo da
-- organização MAIOR que o global não apaga nada a mais (a global já passou por
-- lá), e é a própria arquitetura que garante o teto. A tela confere o teto para
-- avisar o admin; o banco não depende dela.
--
-- ─── O piso mora AQUI, no corpo ────────────────────────────────────────────
-- Como nas irmãs (0187, 0281, 0408): só o piso dentro da função vale para
-- QUALQUER chamador, inclusive um `psql` na mão ou um valor gravado direto em
-- `settings`. Os pisos são os de `lib/retencao/politica.ts`: captação 30,
-- conversa do caso 90, prospecção 90, espelho da agenda 7. Um teste unitário
-- compara as duas tabelas, para elas não divergirem em silêncio.
--
-- ─── Valor que não é número inteiro é IGNORADO ─────────────────────────────
-- `settings` é jsonb livre. Um texto, um decimal, um negativo ou um número com
-- mais de 5 dígitos NÃO vira prazo: vale o global (nada a mais é apagado). Já um
-- inteiro abaixo do piso é elevado ao piso (`greatest`), igual às irmãs.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
-- `create or replace` + revoke/grant declarativos: o `update.sh` de um clone
-- re-executa sem erro. Nenhuma coluna nova, nenhum dado existente é tocado:
-- organização sem `settings.retencao` não muda de comportamento.
-- ═══════════════════════════════════════════════════════════════════════════

-- O piso de cada tipo. Imutável e pura: é a UMA tabela de pisos do SQL, lida
-- pelas outras quatro funções (e conferida contra `lib/retencao/politica.ts`).
-- Tipo desconhecido devolve NULL — quem chama decide o que fazer com ele.
create or replace function public.fn_piso_de_retencao_por_organizacao(p_tipo text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_tipo
    when 'captacao'          then 30
    when 'conversa_do_caso'  then 90
    when 'prospeccao'        then 90
    when 'espelho_da_agenda' then 7
    else null
  end;
$$;

-- O prazo EFETIVO da organização para um tipo: NULL = a organização não tem
-- prazo próprio (vale o global). Tipo desconhecido levanta 22023, para um erro
-- de digitação no chamador não virar "nada a podar" calado.
create or replace function public.fn_prazo_de_retencao_da_organizacao(
  p_organizacao uuid,
  p_tipo text
) returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_piso int := public.fn_piso_de_retencao_por_organizacao(p_tipo);
  v_texto text;
begin
  if v_piso is null then
    raise exception 'retencao_por_organizacao_tipo_desconhecido: %', p_tipo
      using errcode = '22023';
  end if;

  select o.settings #>> array['retencao', p_tipo || '_dias']
    into v_texto
    from public.organizations o
   where o.id = p_organizacao;

  -- Inteiro positivo de até 5 dígitos, e só. `#>>` devolve o texto do número;
  -- um decimal ('90.5'), um sinal ('-3'), um texto ('noventa') ou a ausência
  -- ficam de fora e valem o global.
  if v_texto is null or v_texto !~ '^[0-9]{1,5}$' then
    return null;
  end if;

  return greatest(v_texto::int, v_piso);
end;
$$;

-- Quem tem prazo próprio: uma linha por (organização, tipo). É o que o cron lê
-- para saber o que podar, em vez de varrer `organizations` e adivinhar.
create or replace function public.fn_organizacoes_com_prazo_proprio()
returns table (organization_id uuid, tipo text, dias int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, t.tipo, public.fn_prazo_de_retencao_da_organizacao(o.id, t.tipo)
    from public.organizations o
   cross join (values
     ('captacao'), ('conversa_do_caso'), ('prospeccao'), ('espelho_da_agenda')
   ) as t(tipo)
   where public.fn_prazo_de_retencao_da_organizacao(o.id, t.tipo) is not null
   order by o.id, t.tipo;
$$;

-- A poda: UMA organização e UM tipo por chamada, em lote (mesmo contrato das
-- irmãs: devolve quantas linhas apagou e o cron repete até zerar ou até o teto
-- de lotes). Os critérios por tipo são IDÊNTICOS aos das funções globais — só
-- ganha o filtro da organização e o prazo dela.
create or replace function public.fn_expurgar_por_organizacao(
  p_tipo text,
  p_organizacao uuid,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int;
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int := 0;
begin
  if p_organizacao is null then
    raise exception 'retencao_por_organizacao_sem_organizacao'
      using errcode = '22023';
  end if;

  -- Levanta 22023 para tipo desconhecido; NULL = sem prazo próprio.
  v_dias := public.fn_prazo_de_retencao_da_organizacao(p_organizacao, p_tipo);
  if v_dias is null then
    return 0;
  end if;

  if p_tipo = 'captacao' then
    with vencidos as (
      select c.id from public.webhook_lead_captures c
       where c.organization_id = p_organizacao
         and c.received_at < now() - make_interval(days => v_dias)
       order by c.received_at
       limit v_limite
    )
    delete from public.webhook_lead_captures c using vencidos v where c.id = v.id;
    get diagnostics v_apagadas = row_count;

  elsif p_tipo = 'conversa_do_caso' then
    with vencidas as (
      select m.id from public.agent_case_chat_messages m
       where m.organization_id = p_organizacao
         and m.created_at < now() - make_interval(days => v_dias)
       order by m.created_at
       limit v_limite
    )
    delete from public.agent_case_chat_messages m using vencidas v where m.id = v.id;
    get diagnostics v_apagadas = row_count;

  elsif p_tipo = 'prospeccao' then
    -- As DUAS guardas da 0408 que não são idade: trabalho vivo
    -- (`queued`/`sending`) nunca entra, e o tombstone de LGPD
    -- (`suppression_salt`) sobrevive para sempre — é ele que barra a
    -- reimportação de quem pediu exclusão.
    with vencidos as (
      select c.id from public.prospecting_candidates c
       where c.organization_id = p_organizacao
         and c.status not in ('queued','sending')
         and c.suppression_salt is null
         and coalesce(c.attempted_at, c.created_at)
             < now() - make_interval(days => v_dias)
       order by coalesce(c.attempted_at, c.created_at)
       limit v_limite
    )
    delete from public.prospecting_candidates c using vencidos v where c.id = v.id;
    get diagnostics v_apagadas = row_count;

  elsif p_tipo = 'espelho_da_agenda' then
    with vencidos as (
      select e.id from public.calendar_external_events e
       where e.organization_id = p_organizacao
         and e.ends_at < now() - make_interval(days => v_dias)
       order by e.ends_at
       limit v_limite
    )
    delete from public.calendar_external_events e using vencidos v where e.id = v.id;
    get diagnostics v_apagadas = row_count;
  end if;

  return v_apagadas;
end;
$$;

-- A gravação: o admin da organização (ou da plataforma) define o prazo próprio.
-- `p_prazos` é o ESTADO DESEJADO completo: cada chave presente com número vira
-- prazo; chave ausente ou `null` = herdar o global; objeto vazio ou `null` =
-- tira `settings.retencao` inteiro. Uma instrução só (merge atômico por
-- `jsonb_set`), pelo mesmo motivo da marca (0157): `settings` tem vários donos
-- e o read-modify-write do jsonb inteiro em round-trips separados perde chave
-- alheia em silêncio.
--
-- O teto (o prazo global) NÃO é conferido aqui: o banco não o conhece, e um
-- valor acima dele é inofensivo (ver o cabeçalho). A tela avisa.
create or replace function public.fn_definir_retencao_da_organizacao(
  p_org    uuid,
  p_actor  uuid,
  p_prazos jsonb
) returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linhas integer;
  v_limpar boolean;
  v_limpo  jsonb := '{}'::jsonb;
  v_chave  text;
  v_valor  jsonb;
  v_tipo   text;
  v_piso   int;
  v_numero int;
begin
  if p_org is null or p_actor is null then
    raise exception 'retencao_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  -- "Volte a herdar" chega por DUAS formas (SQL NULL e o jsonb 'null'), como na
  -- marca: as duas significam a mesma coisa.
  v_limpar := p_prazos is null or jsonb_typeof(p_prazos) = 'null';

  if not v_limpar and jsonb_typeof(p_prazos) <> 'object' then
    raise exception 'retencao_da_organizacao_forma_invalida: %', jsonb_typeof(p_prazos)
      using errcode = '22023';
  end if;

  -- Papel insuficiente falha ALTO (42501): 0 já significa "a organização não
  -- existe", e colapsar os dois deixaria o chamador sem saber qual foi.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'retencao_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  if not v_limpar then
    for v_chave, v_valor in select key, value from jsonb_each(p_prazos) loop
      -- A chave é `<tipo>_dias`; o tipo tem de existir na tabela de pisos.
      v_tipo := case when v_chave ~ '_dias$' then left(v_chave, length(v_chave) - 5) end;
      v_piso := public.fn_piso_de_retencao_por_organizacao(v_tipo);
      if v_piso is null then
        raise exception 'retencao_da_organizacao_chave_desconhecida: %', v_chave
          using errcode = '22023';
      end if;

      if jsonb_typeof(v_valor) = 'null' then
        continue;
      end if;

      if jsonb_typeof(v_valor) <> 'number' or (v_valor #>> '{}') !~ '^[0-9]{1,5}$' then
        raise exception 'retencao_da_organizacao_valor_invalido: %', v_chave
          using errcode = '22023';
      end if;

      v_numero := (v_valor #>> '{}')::int;
      if v_numero < v_piso then
        raise exception 'retencao_da_organizacao_abaixo_do_piso: % (minimo %)', v_chave, v_piso
          using errcode = '22023';
      end if;

      v_limpo := v_limpo || jsonb_build_object(v_chave, v_numero);
    end loop;
  end if;

  update public.organizations o
     set settings = case
           when v_limpar or v_limpo = '{}'::jsonb
             then coalesce(o.settings, '{}'::jsonb) - 'retencao'
           else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{retencao}', v_limpo, true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_piso_de_retencao_por_organizacao(text) is
  'O piso de retenção por tipo (captacao 30, conversa_do_caso 90, prospeccao 90, espelho_da_agenda 7); NULL para tipo desconhecido. Espelha lib/retencao/politica.ts — um teste confere.';
comment on function public.fn_prazo_de_retencao_da_organizacao(uuid, text) is
  'O prazo efetivo (dias) que a organização definiu em settings.retencao.<tipo>_dias, elevado ao piso; NULL = sem prazo próprio (vale o global). Tipo desconhecido levanta 22023.';
comment on function public.fn_organizacoes_com_prazo_proprio() is
  'Uma linha (organization_id, tipo, dias) por prazo próprio válido. Lido pelo cron data-retention para saber o que podar.';
comment on function public.fn_expurgar_por_organizacao(text, uuid, int) is
  'Apaga, em lote, o dado pessoal vencido de UMA organização e UM tipo pelo prazo próprio dela (captacao | conversa_do_caso | prospeccao | espelho_da_agenda). Devolve as linhas apagadas; 0 sem prazo próprio. Critérios idênticos aos das podas globais (inclusive as guardas da prospecção).';
comment on function public.fn_definir_retencao_da_organizacao(uuid, uuid, jsonb) is
  'Grava organizations.settings.retencao com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb. p_prazos = estado desejado completo (chave ausente ou null = herdar o global; vazio ou null = remove). Valida chave, número inteiro e piso. Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501.';

-- OS DOIS REVOKES (CLAUDE.md, item 9) — origens DISTINTAS de EXECUTE: o grant
-- que o Postgres dá a PUBLIC ao criar a função (`from public`) e o que o
-- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS TO anon` do baseline dá a
-- toda função criada depois dele (`from anon`). `from authenticated` porque
-- quatro destas funções são security definer e uma é volátil: definer alcançável
-- por qualquer usuário logado seria escrita ou leitura cross-tenant.
revoke execute on function public.fn_piso_de_retencao_por_organizacao(text)
  from public, anon, authenticated;
revoke execute on function public.fn_prazo_de_retencao_da_organizacao(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.fn_organizacoes_com_prazo_proprio()
  from public, anon, authenticated;
revoke execute on function public.fn_expurgar_por_organizacao(text, uuid, int)
  from public, anon, authenticated;
revoke execute on function public.fn_definir_retencao_da_organizacao(uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.fn_piso_de_retencao_por_organizacao(text) to service_role;
grant execute on function public.fn_prazo_de_retencao_da_organizacao(uuid, text) to service_role;
grant execute on function public.fn_organizacoes_com_prazo_proprio() to service_role;
grant execute on function public.fn_expurgar_por_organizacao(text, uuid, int) to service_role;
grant execute on function public.fn_definir_retencao_da_organizacao(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
