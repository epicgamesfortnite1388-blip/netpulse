# NANI API & Event Contracts

## REST (Fastify, validated with zod)
- GET /api/v1/nani/status -> { enabled, intelligenceLevel, lastDiagnosis }
- GET /api/v1/nani/apis -> { apis, count }
- GET /api/v1/nani/health/shadow -> { assessments, count }
- POST /api/v1/nani/apis (RegisterApiBody)
- POST /api/v1/nani/check (CheckApiBody) -> { classification, probe }
- POST /api/v1/nani/diagnose (DiagnoseBody) -> { posterior, top, confidence, entropy, insufficientEvidence, action, explanation, recommendedTest }
- POST /api/v1/nani/recovery/plan (PlanRecoveryBody)
- POST /api/v1/nani/recovery/step (RecordStepBody)
- GET /api/v1/nani/recovery/next?apiId&now
- POST /api/v1/nani/recovery/reset { apiId }

## Events (published via RealtimeBus)
- nani:health:updated
- nani:diagnosis:completed
- nani:recovery:planned
- nani:recovery:step:{status}
- nani:route:activated
- nani:recovery:exhausted

Payloads include seq, at, type, payload, version. Frontend does not yet subscribe; polling used.
