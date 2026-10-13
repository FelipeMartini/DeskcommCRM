"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { useToast } from "@/hooks/use-toast";

interface TenantAiCardProps {
  organizationId: string;
  initialHabilitado?: boolean;
  initialModel?: string;
  omnirouterBaseUrl?: string;
}

export function TenantAiCard({
  organizationId,
  initialHabilitado = false,
  initialModel = "claude-haiku-5-5",
  omnirouterBaseUrl = "https://omnirouter.poa.metodoatuarial.com.br/v1",
}: TenantAiCardProps) {
  const t = useT();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [habilitado, setHabilitado] = useState(initialHabilitado);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel);

  const salvar = () => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/admin/tenants/${organizationId}/ai`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            habilitado,
            apiKey: apiKey.trim() || undefined,
            model: model.trim() || "claude-haiku-5-5",
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || "Erro ao salvar configuração de IA");
        }

        toast({
          title: t("Configuração de IA atualizada"),
          description: habilitado
            ? t("OmniRouter habilitado e configurado com sucesso para este tenant.")
            : t("OmniRouter desabilitado para este tenant."),
        });
      } catch (err) {
        toast({
          title: t("Falha na gravação"),
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Card className="border-primary/20 shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              {t("Inteligência Artificial & OmniRouter")}
              {habilitado ? (
                <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {t("Habilitado")}
                </Badge>
              ) : (
                <Badge variant="secondary">{t("Desabilitado")}</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {t("Controle exclusivo de Super Admin para roteamento via OmniRouter.")}
            </CardDescription>
          </div>
          <Switch
            checked={habilitado}
            onCheckedChange={setHabilitado}
            disabled={isPending}
            aria-label={t("Habilitar OmniRouter")}
          />
        </div>
      </CardHeader>
      {habilitado && (
        <CardContent className="space-y-4 pt-0">
          <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
            <div className="text-muted-foreground font-medium">{t("Endpoint Gateway:")}</div>
            <code className="text-primary font-mono text-[11px] block break-all">
              {omnirouterBaseUrl}
            </code>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="omni-key" className="text-xs">
              {t("Chave API do OmniRouter para esta Organização")}
            </Label>
            <Input
              id="omni-key"
              type="password"
              placeholder={t("Deixe em branco para usar a chave global do sistema...")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={isPending}
              className="text-xs font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("Se não informar chave específica, esta organização utilizará a credencial global da instalação.")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="omni-model" className="text-xs">
              {t("Modelo Padrão da IA")}
            </Label>
            <Input
              id="omni-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isPending}
              className="text-xs font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("Padrão recomendado: claude-haiku-5-5 (alta velocidade e tool calling no WhatsApp).")}
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={salvar} disabled={isPending}>
              {isPending ? t("Gravando...") : t("Salvar Configuração")}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
