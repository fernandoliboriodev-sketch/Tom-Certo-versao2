# Tom Certo — PRD

## Problema Original
Debug técnico completo e correção do bug "Recording is already in progress" no APK Android do app Tom Certo.

## Arquitetura
- **Frontend**: Expo React Native (SDK 54), `@siteed/audio-studio` para captura nativa de PCM
- **Backend**: FastAPI + MongoDB (Motor async)
- **Auth**: Sistema de tokens por código com JWT session

## O que foi Implementado (20/04/2026)

### Fixes Críticos (Bug: "Recording is already in progress")
1. **`src/audio/usePitchEngine.ts`** — 5 fixes:
   - `isStartingRef` lock: previne chamadas concorrentes a `start()`
   - Guard de sessão ativa: se `activeRef=true`, força `stop()` antes de iniciar nova sessão
   - `activeRef.current = true` movido para APÓS `recorder.startRecording()` ter sucesso
   - Safety delay de 250ms em `stop()` para o Android liberar AudioRecord
   - Logs detalhados em todos os pontos-chave do fluxo

2. **`src/hooks/useKeyDetection.ts`** — 3 fixes:
   - `isStartingRef` lock: previne chamadas concorrentes a `start()`
   - `start()` agora para a sessão anterior com AWAIT antes de iniciar nova
   - Stop preventivo mesmo quando `isRunning=false` (segurança contra race condition)

### Arquivos Criados/Modificados
- `/app/frontend/src/audio/types.ts` — tipos compartilhados
- `/app/frontend/src/audio/yin.ts` — algoritmo YIN de detecção de pitch
- `/app/frontend/src/audio/usePitchEngine.ts` — engine nativa (COM FIXES)
- `/app/frontend/src/audio/usePitchEngine.web.ts` — fallback web
- `/app/frontend/src/hooks/useKeyDetection.ts` — hook principal (COM FIXES)
- `/app/frontend/src/utils/noteUtils.ts` — utilitários musicais
- `/app/frontend/src/utils/keyDetector.ts` — algoritmo Krumhansl-Schmuckler
- `/app/frontend/src/auth/storage.ts` — armazenamento seguro
- `/app/frontend/src/auth/deviceId.ts` — ID de dispositivo estável
- `/app/frontend/src/auth/AuthContext.tsx` — contexto de autenticação
- `/app/frontend/src/auth/AuthLoadingScreen.tsx` — tela de carregamento
- `/app/frontend/src/auth/ActivationScreen.tsx` — tela de ativação
- `/app/frontend/app/_layout.tsx` — layout raiz com AuthGate
- `/app/frontend/app/index.tsx` — tela principal (3 estados: initial/listening/detected)
- `/app/frontend/app.json` — adicionado RECORD_AUDIO + @siteed/audio-studio plugin
- `/app/backend/server.py` — API FastAPI completa com sistema de tokens

### Dependências Instaladas
- `@expo-google-fonts/manrope`, `@expo-google-fonts/outfit`
- `@siteed/audio-studio@3.0.3`
- `expo-application@7.0.8`, `expo-secure-store@15.0.8`
- Backend: `PyJWT`, `passlib[bcrypt]`, `motor`, `python-dotenv`

## Causa Raiz do Bug Identificada

### Problema Principal
O erro "Recording is already in progress" era causado por:

1. **`stop()` sem await em `useKeyDetection`**: `engineRef.current?.stop()` era fire-and-forget. 
   O `recorder.stopRecording()` nativo não completava antes de `startRecording()` ser chamado.

2. **`activeRef.current = true` antes do startRecording()**: Se o start falhava, 
   o flag ficava `true` incorretamente, causando guards incorretos na próxima tentativa.

3. **Sem lock `isStartingRef`**: Múltiplos cliques ou re-renders podiam chamar `start()` 
   concorrentemente, causando dois `startRecording()` nativos simultâneos.

4. **Sem safety delay após stop()**: Android precisa de ~200ms para liberar AudioRecord 
   completamente após `stopRecording()`.

## Backlog Prioritizado

### P0 — Concluído
- [x] Fix "Recording is already in progress"
- [x] Logs detalhados para diagnóstico
- [x] Guards de estado no fluxo start/stop
- [x] Backend completo com sistema de tokens

### P1 — Próximos Passos
- [ ] Gerar novo APK com os fixes aplicados (via EAS Build)
- [ ] Testar no dispositivo Android real

### P2 — Melhorias Futuras  
- [ ] Admin UI completa (HTML)
- [ ] Notificação quando token está próximo de expirar
- [ ] Histórico de sessões de detecção
