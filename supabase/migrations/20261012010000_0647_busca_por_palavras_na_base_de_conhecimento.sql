-- manifest: a base de conhecimento ganha a busca por palavras (família "texto"): fn_buscar_trechos_por_texto procura no próprio Postgres, em português e sem acento, sem vetor, sem chave e sem custo — a organização sem crédito de embedding passa a ter base.
--
-- POR QUE
-- A base de conhecimento só existia com um provedor de embedding (OpenAI, OpenRouter ou
-- Google). Sem crédito em nenhum, o material fica "esperando para ser preparado" para
-- sempre e o agente responde sem consultar nada. Quem opera o CRM com uma assinatura de
-- IA (a claude-ponte) não tem como gerar embedding por ela: a assinatura só devolve texto.
--
-- O QUE FAZ
-- Uma terceira família de base, "texto" (modelo marcador `texto/postgres-fts` em
-- `ai_knowledge_versions.embedding_model`). O material é cortado em trechos como sempre,
-- mas o vetor gravado em `ai_chunks.embedding` é zero (a coluna segue NOT NULL e o índice
-- ivfflat com cosseno ignora vetor de norma zero), e a pergunta é respondida por palavras:
--
--   1. a pergunta vira lexemas do dicionário `portuguese` (sem stopword, plural e
--      conjugação reduzidos ao radical), depois de tirar o acento dos dois lados;
--   2. cada trecho dos materiais que o agente pode ler recebe a COBERTURA PONDERADA: a
--      soma do peso (idf: ln(1 + N / (1 + df))) dos termos da pergunta que o trecho
--      contém, dividida pela soma do peso de TODOS os termos da pergunta. Vai de 0 a 1, e
--      "1" é "o trecho tem toda a pergunta". Termo que aparece em todo trecho pesa pouco;
--      termo raro pesa muito;
--   3. só voltam trechos com ao menos um termo e nota >= `p_threshold`, do melhor para o
--      pior, no mesmo formato de `fn_buscar_trechos_das_fontes` (quem chama troca uma
--      função pela outra sem mexer no resto).
--
-- NÃO FAZ
-- Não entende sinônimo nem paráfrase ("aplicativo" não acha "app"): quem escreve a
-- pergunta de busca — o próprio agente — põe os dois termos. Não usa índice (o
-- `to_tsvector` é calculado na hora sobre os trechos dos materiais pedidos, que numa
-- base de atendimento são centenas, não milhões); um tsvector gerado + GIN fica para
-- quando uma base real passar de alguns milhares de trechos.
--
-- SEGURANÇA
-- Idêntica à `fn_buscar_trechos_das_fontes` (0181): SECURITY DEFINER, search_path fixo,
-- filtro de organização programático, gate de membership quando há `auth.uid()`,
-- revogada de public e anon.

-- Tira o acento e põe em minúsculas. IMMUTABLE e sem depender de locale (o `lower` do
-- Postgres só trata acento se o banco foi criado com locale que o conheça; o `translate`
-- vem antes e cobre as maiúsculas acentuadas).
create or replace function public.fn_normaliza_para_busca(p_texto text)
  returns text
  language sql immutable parallel safe
  set search_path to 'public'
as $$
  select lower(translate(
    coalesce(p_texto, ''),
    'áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'
  ))
$$;

comment on function public.fn_normaliza_para_busca(text) is
  'Tira o acento e põe em minúsculas, sem depender de locale. Usada pela busca por palavras da base de conhecimento (0647).';

revoke execute on function public.fn_normaliza_para_busca(text) from public, anon;
grant  execute on function public.fn_normaliza_para_busca(text) to authenticated, service_role;

create or replace function public.fn_buscar_trechos_por_texto(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_query text,
  p_k integer default 5,
  p_threshold real default 0,
  p_embedding_model text default null
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
declare
  v_termos text[];
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_por_texto: caller must be an active member of the organization';
  end if;

  -- Os termos distintos da pergunta, como o dicionário os guarda. Pergunta feita só de
  -- palavra vazia ("e o de?") não tem termo, e não achar nada é a resposta certa.
  select coalesce(array_agg(distinct l.lexeme), '{}'::text[])
    into v_termos
    from unnest(
      to_tsvector('portuguese', public.fn_normaliza_para_busca(p_query))
    ) as l(lexeme, positions, weights);

  if coalesce(cardinality(v_termos), 0) = 0 then
    return;
  end if;

  return query
  with candidatos as (
    select
      c.id as cid,
      c.knowledge_source_id as sid,
      s.name as nome,
      c.content as texto,
      c.metadata as meta,
      c."position" as pos,
      tsvector_to_array(
        to_tsvector('portuguese', public.fn_normaliza_para_busca(c.content))
      ) as lexemas
    from public.ai_chunks c
    join public.ai_knowledge_sources s
      on s.id = c.knowledge_source_id
     and s.organization_id = c.organization_id
    join public.ai_knowledge_versions v
      on v.id = c.kb_version_id
    where c.organization_id = p_organization_id
      and s.id = any(p_source_ids)
      and s.is_active
      and s.status = 'ready'
      and c.kb_version_id = s.active_kb_version_id
      and (
        p_embedding_model is null
        or v.embedding_model is null
        or v.embedding_model = p_embedding_model
      )
  ),
  total as (
    select count(*)::double precision as n from candidatos
  ),
  pesos as (
    select
      t.termo,
      ln(
        1 + (select n from total)
          / (1 + (select count(*) from candidatos cd where t.termo = any(cd.lexemas)))::double precision
      ) as peso
    from unnest(v_termos) as t(termo)
  ),
  soma as (
    select sum(peso) as total_dos_pesos from pesos
  ),
  notas as (
    select
      cd.*,
      coalesce(
        (select sum(p.peso) from pesos p where p.termo = any(cd.lexemas)),
        0
      ) / nullif((select total_dos_pesos from soma), 0) as nota
    from candidatos cd
  )
  select
    n.cid as chunk_id,
    n.sid as knowledge_source_id,
    n.nome as source_name,
    n.texto as content,
    least(n.nota, 1)::real as similarity,
    n.meta as metadata
  from notas n
  where n.nota > 0
    and n.nota >= p_threshold
  order by n.nota desc, n.pos asc
  limit greatest(p_k, 0);
end $$;

comment on function public.fn_buscar_trechos_por_texto(uuid, uuid[], text, integer, real, text) is
  'Busca por palavras (português, sem acento) nos materiais que o agente pode ler: nota = cobertura ponderada por idf dos termos da pergunta (0181 irmã sem vetor; 0647). SECURITY DEFINER + filtro programático de organização — quem chama valida o tenant.';

revoke execute on function public.fn_buscar_trechos_por_texto(uuid, uuid[], text, integer, real, text) from public, anon;
grant  execute on function public.fn_buscar_trechos_por_texto(uuid, uuid[], text, integer, real, text) to authenticated, service_role;
