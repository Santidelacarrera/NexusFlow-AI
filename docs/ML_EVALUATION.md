# Evaluación del modelo de abandono y segmentación

Esta evaluación está **separada del producto**: vive en `services/ml/evaluation.py`, `metrics.py` y `datasets.py`. Solo importa la configuración desplegada (`model.build_model`, `model.heuristic_probability`) y nunca escribe en los modelos de las organizaciones. `model.py` usa `metrics.classification_metrics` para las cifras que ve el usuario, de modo que producto y evaluación comparten un único cálculo.

## Cómo reproducirla

```bash
cd services/ml
python evaluation.py --out reports/ml_evaluation.json      # ~25 s, CPU
python -m pytest -q test_evaluation.py                      # determinismo, líneas base, control de fugas
# En Docker:  docker compose exec ml python evaluation.py --out /tmp/ml_evaluation.json
```

El informe incluye `reproducibilityHash`: hash del bloque `results` (sin tiempos ni versiones). Dos ejecuciones con las mismas versiones de librerías (`requirements.lock`) producen el mismo hash; la prueba `test_results_are_reproducible` lo comprueba. Cualquier cambio en datos, modelo o métricas cambia el hash y deja un rastro revisable. El informe de referencia está en `services/ml/reports/ml_evaluation.json`.

## Conjunto de datos definido

Generador determinista (`datasets.make_churn_benchmark`, semilla `20261001`) con huella SHA-256 registrada en el informe. Proceso: 900 clientes, 540 días de historia; compras como proceso de Poisson con tasa lognormal por cliente (mediana 1 compra/35 días); importe lognormal por cliente; el 40 % de los clientes "abandona" en un instante aleatorio y deja de comprar. La etiqueta es la definición del producto (`features.py`): sin compra en los 90 días previos a la fecha de evaluación, con atributos calculados solo con datos anteriores al corte. Resultado: 866 clientes elegibles, 37,2 % de abandono.

## Resultados (validación cruzada 3×5 estratificada, clientes disjuntos)

| Modelo           | PR-AUC (media ± DE) | ROC-AUC | F1 @0.5 | Brier | Lift decil superior |
| ---------------- | ------------------- | ------- | ------- | ----- | ------------------- |
| xgboost          | 0.783 ± 0.051       | 0.843   | 0.710   | 0.151 | 2.47                |
| baseline_prior   | 0.372 ± 0.002       | 0.500   | 0.000   | 0.234 | 1.06                |
| baseline_recency | 0.764 ± 0.059       | 0.834   | 0.701   | 0.158 | 2.44                |
| baseline_logreg  | 0.775 ± 0.055       | 0.833   | 0.651   | 0.157 | 2.41                |

| Comparación (PR-AUC)        | Diferencia media | IC 95 %          | ¿Excluye 0? |
| --------------------------- | ---------------- | ---------------- | ----------- |
| xgboost_vs_baseline_prior   | +0.409           | [+0.365, +0.457] | sí          |
| xgboost_vs_baseline_recency | +0.019           | [-0.001, +0.041] | no          |
| xgboost_vs_baseline_logreg  | +0.013           | [-0.006, +0.033] | no          |

Estabilidad entre semillas del modelo: PR-AUC 0.832 ± 0.0000. Estabilidad entre muestras sintéticas: xgboost supera a baseline_prior 5/5, baseline_recency 1/5, baseline_logreg 2/5.
Control con etiquetas barajadas: PR-AUC 0.399 (prevalencia 0.372).
Rendimiento (referencia local): entrenamiento 0.02 s, predicción de 1000 filas 2.5 ms, SHAP de 1000 filas 42 ms.

Errores a umbral 0,5 (predicciones fuera de muestra promediadas, 866 clientes): XGBoost 224 VP / 87 FP / 98 FN / 457 VN; recencia 212 / 71 / 110 / 473; regresión logística 183 / 56 / 139 / 488; línea base de prior 0 / 0 / 322 / 544.

### Qué significan

- **Frente a la línea base trivial (prevalencia) el modelo gana con claridad**: +0,41 PR-AUC, IC 95 % que excluye 0, en 5 de 5 muestras sintéticas.
- **Frente a líneas base sencillas pero razonables, la ventaja no es demostrable.** Ordenar clientes solo por días sin comprar alcanza 0,764 PR-AUC frente a 0,783 de XGBoost; la diferencia (+0,019, IC 95 % [−0,001, +0,041]) incluye 0, y XGBoost solo supera a la recencia en 1 de 5 muestras. La regresión logística tampoco queda claramente por debajo. En estos datos, **la señal está casi toda en la recencia**.
- **Promoción en producción:** `model.train` promueve el modelo si supera la línea base de prior (criterio histórico). El informe de entrenamiento ahora incluye también `recencyBaseline` y `beatsRecencyBaseline` para que el usuario vea si el modelo aporta algo sobre la regla simple. No se endureció el criterio de promoción para no cambiar el comportamiento sin datos reales que lo justifiquen.
- **Estabilidad:** la variación relevante es entre particiones de datos (DE de PR-AUC ≈ 0,05 por pliegue), no entre semillas del modelo: con `subsample=1` y `colsample=1` XGBoost es determinista, por lo que la DE entre semillas es 0. No debe interpretarse como "el modelo es estable" sino como "no hay aleatoriedad interna". Con pocos cientos de clientes, diferencias de ±0,05 PR-AUC entre particiones son normales.
- **Calibración:** las probabilidades son razonables en los extremos pero irregulares en bandas intermedias (p. ej. 0,6–0,7 observado 76 % vs 66 % previsto; 0,7–0,8 observado 63 % vs 75 %) con 40–80 clientes por banda. No son probabilidades calibradas para decisiones de coste.
- **Control de fugas:** con etiquetas barajadas el PR-AUC es 0,399 (prevalencia 0,372); no hay señal sin relación real etiqueta–atributos.
- **Rendimiento (referencia local, 866 filas):** entrenamiento ≈ 0,02 s, predicción de 1000 filas ≈ 2,5 ms, SHAP de 1000 filas ≈ 42 ms. No se midieron cargas grandes (decenas de miles de clientes) ni memoria.

## Límites de SHAP

Medidos en `results.shap` y verificados en `test_shap_diagnostics`:

1. **Aditividad correcta, interpretación limitada.** La suma de contribuciones más el valor base reproduce el margen del modelo (error máximo 2·10⁻⁶), pero las contribuciones están en _log-odds_ y explican al **modelo**, no al mundo: no implican causalidad ni que intervenir en un atributo cambie el resultado.
2. **Colinealidad.** `frequency` y `monetary` tienen correlación de Spearman 0,80 (y recencia −0,44). SHAP reparte el crédito entre atributos correlacionados de forma que depende del modelo; la importancia individual de `frequency` y `monetary` (≈ 0,19 y 0,20 frente a 1,29 de recencia) no debe leerse como efecto separado.
3. **Estabilidad.** El ranking de importancia es idéntico entre semillas (ρ = 1), pero eso se debe a que el modelo es determinista (ver arriba); no mide estabilidad frente a datos nuevos. Con otros datos, el ranking de los dos atributos correlacionados puede invertirse.
4. **Solo 3 atributos.** Sin variables de producto, canal, soporte o estacionalidad, las explicaciones son un resumen de recencia/frecuencia/importe, no de las causas del abandono.
5. **Coste.** El cálculo exacto de TreeSHAP es barato aquí (≈ 42 ms por 1000 filas) pero crece con la profundidad y el número de árboles.

## Límites de los datos

- **Sintéticos.** Se generaron con un proceso simple (compras de Poisson independientes, abandono abrupto). Los clientes reales tienen estacionalidad, campañas, compras en ráfagas y abandonos graduales. Los resultados sirven para **comparar modelos y detectar regresiones**, no para predecir el rendimiento comercial.
- **Etiqueta ruidosa por diseño.** "Sin compra en 90 días" mezcla abandono real con clientes de baja frecuencia; parte del error es irreducible con estos atributos.
- **Tamaño.** Unos 870 clientes; los IC son anchos. Una diferencia de 0,02 PR-AUC no es detectable.
- **Un solo corte temporal.** La evaluación no valida el comportamiento a lo largo del tiempo (deriva); la partición es por clientes con un único corte histórico.
- **Sin coste de negocio.** No se optimiza el umbral por coste de retención ni se mide el efecto de una intervención (requiere un experimento controlado).
- **Moneda.** Los importes se tratan como numéricos; no se normaliza inflación ni conversión entre monedas (la plataforma rechaza monedas mezcladas).

## Recomendaciones antes de usar el modelo con datos reales

1. Repetir esta evaluación con los datos de la organización (mismo código, `--seed` y partición por cliente) y comprobar si el modelo supera a la recencia con un IC que excluya 0.
2. Si no la supera, usar la heurística de recencia (más simple y explicable) y reservar el modelo para cuando haya más atributos.
3. Calibrar (isotónica/Platt) si las probabilidades se usan para decidir presupuesto.
4. Evaluar con una ventana temporal posterior (backtest) y monitorizar deriva.
