-- manifest: define Claude Haiku 4.5 (3.5/4.5 Haiku) como modelo padrão da Anthropic e da organização, preparando o ambiente para OmniRouter
--
-- POR QUE
-- O modelo padrão anterior (Claude Sonnet 4.6) é excelente para raciocínio complexo, mas
-- para atendimento ao cliente e suporte ágil no WhatsApp, o Haiku oferece latência
-- muito inferior (respostas quase instantâneas), custo consideravelmente menor e atende
-- com folga às tarefas de conversa, chamadas de ferramentas e roteamento do OmniRouter.
--
-- O QUE FAZ
-- 1. Marca 'claude-haiku-4-5' como o modelo padrão do provedor Anthropic em public.ai_models.
-- 2. Atualiza a função fn_seed_org_llm_defaults() para que novas organizações nasçam com
--    'claude-haiku-4-5' como default_model.
-- 3. Atualiza as organizações existentes que ainda estavam com 'claude-sonnet-4-6' não customizado.

-- 1. Altera o modelo padrão da Anthropic no catálogo global
update public.ai_models
set is_default_for_provider = false
where provider = 'anthropic' and is_default_for_provider = true;

update public.ai_models
set is_default_for_provider = true
where provider = 'anthropic' and model_id = 'claude-haiku-4-5';

-- 2. Atualiza o trigger seed para novas organizações
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
               'claude-haiku-4-5'
             )
           ),
      true
    );
  end if;
  return new;
end;
$$;

-- 3. Atualiza organizações que utilizam o padrão antigo
update public.organizations
set settings = jsonb_set(settings, '{llm,default_model}', '"claude-haiku-4-5"'::jsonb)
where coalesce(settings->'llm'->>'default_model', '') = 'claude-sonnet-4-6';
