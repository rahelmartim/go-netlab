package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
)

func ErrorHandle(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
		fmt.Println("Exitting")
		os.Exit(0)
	}
}

func PrintErrorIfExists(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
	}
}

func main() {
	fmt.Println("Client Initiated...")

	ServerAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:10001")
	ErrorHandle(err)

	fmt.Println("Address Solved...")

	LocalAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	ErrorHandle(err)

	Conn, err := net.DialUDP("udp", LocalAddr, ServerAddr)
	ErrorHandle(err)

	fmt.Println("Client Connected...")

	defer Conn.Close()

	reader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("Enter text: ")
		msgPack, _ := reader.ReadString('\n')
		msgPack = strings.TrimSuffix(msgPack, "\n")

		buf := []byte(msgPack)

		fmt.Println("sending mensage: ", msgPack)

		_, err := Conn.Write(buf)
		PrintErrorIfExists(err)

		bufRecived := make([]byte, 1024)
		n, _, err := Conn.ReadFromUDP(bufRecived)
		PrintErrorIfExists(err)

		fmt.Println("Received ", string(bufRecived[0:n]), " from server")
	}

}
