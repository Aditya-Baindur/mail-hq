FROM golang:1.26.2-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bridge .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=build /bridge /usr/local/bin/mailhq-bridge
EXPOSE 993 465 8080
ENTRYPOINT ["/usr/local/bin/mailhq-bridge"]
