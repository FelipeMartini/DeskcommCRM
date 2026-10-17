-- manifest: define Claude Haiku 5.5 como modelo padrão da Anthropic e da organização, com suporte à infraestrutura OmniRouter
--
-- POR QUE
-- O modelo Claude Haiku 5.5 é o padrão ideal para atendimento ao cliente e suporte ágil
-- no WhatsApp via CRM, oferecendo latência ultra-baixa, custo reduzido e capacidade
-- completa de raciocínio e execução de ferramentas (tool calling).
--
-- O QUE FAZ
-- 1. Desmarca o padrão anterior da Anthropic (antes, por causa do índice único de um padrão por provedor),
--    insere e marca 'claude-haiku-5-5' (Claude Haiku 5.5) como o modelo padrão do provedor Anthropic em public.ai_models.
-- 2. Atualiza a função fn_seed_org_llm_defaults() para que novas organizações nasçam com
--    'claude-haiku-5-5' como default_model.
-- 3. Atualiza as organizações existentes para usarem 'claude-haiku-5-5'.

-- 0. Desmarca o padrão anterior da Anthropic ANTES de marcar o novo.
-- O índice `ai_models_one_default_per_provider` é UNIQUE parcial e IMEDIATO (um padrão por provedor):
-- marcar `claude-haiku-5-5` enquanto outro modelo da Anthropic ainda é o padrão quebra a migration no
-- meio (violação de unicidade). Foi o que aconteceu na janela de 16/10/2026, que precisou de um prelúdio
-- à mão. Idempotente: com o Haiku 5.5 já padrão, nenhuma linha casa.
update public.ai_models
set is_default_for_provider = false
where provider = 'anthropic' and model_id <> 'claude-haiku-5-5' and is_default_for_provider;

-- 1. Insere ou atualiza o modelo Claude Haiku 5.5 no catálogo global da Anthropic
insert into public.ai_models (
  provider,
  model_id,
  display_name,
  description,
  context_window,
  input_price_per_million_cents,
  output_price_per_million_cents,
  supports_tools,
  is_default_for_provider
) values (
  'anthropic',
  'claude-haiku-5-5',
  'Claude Haiku 5.5',
  'Flagship Speed & Intelligence — Atendimento ágil, alta precisão e padrão recomendado',
  200000,
  100,
  500,
  true,
  true
)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  is_default_for_provider = true,
  supports_tools = true;

-- 2. Atualiza o trigger seed para que novas organizações usem 'claude-haiku-5-5'
create or replace function public.fn_seed_org_llm_defaults() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object(
             'provider', 'anthropic',
             'default_model', coalesce(
               (select m.model_id from public.ai_models m
                where m.provider = 'anthropic' and m.is_default_for_provider
                  and m.deprecated_at is null limit 1),
               'claude-haiku-5-5'
             )
           ),
      true
    );
  end if;
  return new;
end;
$$;

-- 3. Atualiza organizações existentes que utilizam Sonnet ou versões anteriores para Haiku 5.5
update public.organizations
set settings = jsonb_set(settings, '{llm,default_model}', '"claude-haiku-5-5"'::jsonb)
where coalesce(settings->'llm'->>'default_model', '') in ('claude-sonnet-4-6', 'claude-haiku-4-5', '');
