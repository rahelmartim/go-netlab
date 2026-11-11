package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
)

var NICK string

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

func ServerListenHandle(Connection *net.UDPConn) {
	for {
		bufRecived := make([]byte, 1024)
		n, _, err := Connection.ReadFromUDP(bufRecived)
		PrintErrorIfExists(err)

		fmt.Println(string(bufRecived[0:n]))
	}
}

func main() {
	/*Utils*/
	reader := bufio.NewReader(os.Stdin)

	/*UDP Dial*/
	fmt.Println("Client Initiated...")
	ServerAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:10001")
	ErrorHandle(err)
	fmt.Println("Address Solved...")
	LocalAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	ErrorHandle(err)
	Conn, err := net.DialUDP("udp", LocalAddr, ServerAddr)
	ErrorHandle(err)

	/*Defer close UDP connection*/
	defer Conn.Close()
	defer fmt.Println("Goodbye.")

	/*Client Auth*/
	fmt.Print("Nickname: ")
	clientNickname, _ := reader.ReadString('\n')
	clientNickname = strings.TrimSuffix(clientNickname, "\n")
	//trying connect
	fmt.Println("Connecting...")
	buf := []byte(clientNickname)
	_, err = Conn.Write(buf)
	PrintErrorIfExists(err)
	//receive response
	bufRecived := make([]byte, 1024)
	n, _, err := Conn.ReadFromUDP(bufRecived)
	PrintErrorIfExists(err)
	if string(bufRecived[0:n]) == "SUCCESS" {
		fmt.Println("Client Connected...")
		NICK = clientNickname
	} else {
		fmt.Println("Auth Error.")
		return
	}

	/*Listen Server msg's*/
	go ServerListenHandle(Conn)

	/*Send msg's*/
	for {
		//fmt.Print("[", NICK, "]: ")
		msgPack, _ := reader.ReadString('\n')
		msgPack = strings.TrimSuffix(msgPack, "\n")

		buf := []byte(msgPack)

		_, err := Conn.Write(buf)
		PrintErrorIfExists(err)

	}

}
