# source-server / source-worker 多阶段镜像（单镜像双二进制，compose 选择 command）
FROM golang:1.26.6 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/source-server ./source-server/cmd/server \
 && CGO_ENABLED=0 go build -trimpath -o /out/source-worker ./source-worker/cmd/worker
# 预置 /data 并赋予 nonroot(65532)；空命名卷首次挂载会继承此目录属主
RUN mkdir -p /data && chown -R 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/source-server /app/source-server
COPY --from=build /out/source-worker /app/source-worker
COPY migrations /app/migrations
COPY --from=build --chown=65532:65532 /data /data
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 8080
# 用 CMD 而非 ENTRYPOINT：compose 的 command 可完整覆盖为 source-worker
CMD ["/app/source-server"]
